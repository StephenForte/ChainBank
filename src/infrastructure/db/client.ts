import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DatabaseConfig } from '../../config/index.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  /** Releases every pooled connection. Cron entry points must await this before exit. */
  close(): Promise<void>;
}

/**
 * Builds a bounded connection pool.
 *
 * The pool ceiling is role-specific: a long-lived API needs headroom for
 * concurrent requests, while a cron process that runs for seconds must not
 * hold connections the API could be using.
 */
export function createDatabase(config: DatabaseConfig, logger: Logger): DatabaseHandle {
  const ssl = buildSslOptions(config);
  if (config.useSsl && config.sslCertificateAuthority !== undefined) {
    // Operators must not assume hostname/SAN verification; identity is leaf pin only.
    logger.info(describeDatabaseTlsPin(config.sslCertificateAuthority), 'Database TLS pin mode');
  }

  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Fail a hung query rather than pinning a connection indefinitely.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    ssl,
  });

  // An idle client can fail independently of any query. Without this listener
  // node-postgres raises an unhandled error event and terminates the process.
  pool.on('error', (error) => {
    logger.error({ error: describeUnknownError(error) }, 'Idle database client error');
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * TLS options for Postgres.
 *
 * Verification is never disabled (`rejectUnauthorized: true` + leaf pin).
 *
 * Render's cert CN is a UUID while DATABASE_URL uses `dpg-…-a`. Setting
 * `ssl.servername` does **not** work: node-postgres overwrites it with the TCP
 * host after merging ssl options (`pg/lib/connection.js` upgradeToSSL). Hostname
 * checks therefore always fail unless we supply `checkServerIdentity`.
 *
 * Trust here is **leaf-only certificate pinning**: the peer certificate's
 * fingerprint256 must equal the fingerprint of `DATABASE_SSL_CA`. Hostname /
 * SAN matching against the connection host is intentionally not used.
 */
export function buildSslOptions(config: DatabaseConfig): pg.PoolConfig['ssl'] {
  if (!config.useSsl) {
    return false;
  }
  if (config.sslCertificateAuthority === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'TLS is enabled for the database but no certificate authority was configured',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const ca = normalizePem(config.sslCertificateAuthority);
  assertValidPemCertificate(ca);

  return {
    rejectUnauthorized: true,
    ca,
    checkServerIdentity: createPinnedCaCheckServerIdentity(ca),
  };
}

/**
 * Safe TLS pin diagnostics for structured logs.
 * Never include PEM body, private keys, or DATABASE_URL credentials.
 */
export function describeDatabaseTlsPin(sslCertificateAuthority: string): {
  readonly databaseTlsPinMode: 'leaf';
  readonly databaseTlsCaFingerprint256: string;
} {
  const ca = normalizePem(sslCertificateAuthority);
  assertValidPemCertificate(ca);
  return {
    databaseTlsPinMode: 'leaf',
    databaseTlsCaFingerprint256: new X509Certificate(ca).fingerprint256,
  };
}

/**
 * Replaces Node's hostname check. node-postgres forces `servername` to the
 * connection host, which never matches Render's UUID CN.
 *
 * Leaf-only pin: accept only when the peer certificate fingerprint256 equals
 * the pinned PEM's fingerprint256. Hostname is ignored for acceptance.
 */
export function createPinnedCaCheckServerIdentity(
  caPem: string,
): (hostname: string, peerCert: PeerCertificate) => Error | undefined {
  const pinnedFingerprint = new X509Certificate(caPem).fingerprint256;

  return (_hostname, peerCert) => {
    if (peerCert.raw === undefined) {
      return new Error('Peer certificate missing raw bytes');
    }

    const peerFingerprint = new X509Certificate(peerCert.raw).fingerprint256;
    if (peerFingerprint !== pinnedFingerprint) {
      return new Error('Peer certificate fingerprint does not match DATABASE_SSL_CA leaf pin');
    }

    return undefined;
  };
}

/**
 * Normalizes PEMs stored in hosted env UIs.
 *
 * Render often collapses newlines. Operators may paste a JSON-escaped string
 * (`\\n`) or a single-line PEM; both must become a parseable certificate.
 */
export function normalizePem(value: string): string {
  let pem = value.trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }

  pem = pem.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\r\n', '\n');

  if (pem.includes('-----BEGIN CERTIFICATE-----') && !pem.includes('\n')) {
    const match = /-----BEGIN CERTIFICATE-----(.*)-----END CERTIFICATE-----/s.exec(pem);
    if (match?.[1] !== undefined) {
      const body = match[1].replace(/\s+/g, '');
      const lines = body.match(/.{1,64}/g) ?? [];
      pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
    }
  }

  return pem.trim() + '\n';
}

export function assertValidPemCertificate(pem: string): void {
  try {
    // Throws if the PEM cannot be parsed — the usual cause of opaque
    // DEPTH_ZERO_SELF_SIGNED_CERT when a mangled CA was ignored by Node.
    new X509Certificate(pem);
  } catch (error) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'DATABASE_SSL_CA is not a valid X.509 PEM certificate. ' +
        'Re-export with scripts/print-database-ca.mjs and paste the ESCAPED one-liner.',
      {
        publicMessage: 'The service is misconfigured.',
        cause: error,
      },
    );
  }
}

/**
 * Wraps a database call so that infrastructure failures surface as a typed
 * dependency error instead of leaking driver detail or a connection string.
 */
export async function withDatabaseErrors<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ChainBankError) {
      throw error;
    }
    throw new ChainBankError('DATABASE_UNAVAILABLE', `Database operation "${operation}" failed`, {
      context: { operation, detail: describeUnknownError(error) },
      cause: error,
    });
  }
}

/** True when the error (or a nested cause) is a Postgres unique-violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object' && 'code' in current && Reflect.get(current, 'code') === '23505') {
      return true;
    }
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}
