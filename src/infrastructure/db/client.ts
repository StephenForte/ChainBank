import { X509Certificate } from 'node:crypto';
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
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Fail a hung query rather than pinning a connection indefinitely.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    ssl: buildSslOptions(config),
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
 * Verification is never disabled. Hosted providers whose CA is absent from the
 * Node trust store must supply DATABASE_SSL_CA; configuration loading fails
 * closed before we reach this point without one.
 *
 * Render Postgres presents a certificate whose CN is an internal UUID, while
 * DATABASE_URL uses the private hostname (`dpg-…-a`). We keep
 * `rejectUnauthorized: true` and pin that certificate via `ca`, then set
 * `servername` to the pinned cert's identity so Node's hostname check matches
 * the CN/SAN instead of the connection host. We do not disable verification.
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
    servername: tlsServerNameFromPinnedCa(ca),
  };
}

/**
 * Identity Node should verify against the peer certificate.
 *
 * Prefer the first DNS SAN; otherwise use the subject CN. Render's managed
 * Postgres certs typically use a UUID CN with no SAN.
 */
export function tlsServerNameFromPinnedCa(pem: string): string {
  const cert = new X509Certificate(pem);
  const dnsSan = firstDnsSubjectAltName(cert.subjectAltName);
  if (dnsSan !== undefined) {
    return dnsSan;
  }

  const commonName = commonNameFromSubject(cert.subject);
  if (commonName !== undefined) {
    return commonName;
  }

  throw new ChainBankError(
    'INVALID_CONFIGURATION',
    'DATABASE_SSL_CA has neither a DNS SAN nor a CN; cannot set TLS servername',
    { publicMessage: 'The service is misconfigured.' },
  );
}

function firstDnsSubjectAltName(subjectAltName: string | undefined): string | undefined {
  if (subjectAltName === undefined) {
    return undefined;
  }
  for (const part of subjectAltName.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('DNS:')) {
      const name = trimmed.slice('DNS:'.length).trim();
      if (name !== '') {
        return name;
      }
    }
  }
  return undefined;
}

function commonNameFromSubject(subject: string): string | undefined {
  for (const part of subject.split(/[\n,]/)) {
    const trimmed = part.trim();
    if (trimmed.startsWith('CN=')) {
      const name = trimmed.slice('CN='.length).trim();
      if (name !== '') {
        return name;
      }
    }
  }
  return undefined;
}

/**
 * Normalizes PEMs stored in hosted env UIs.
 *
 * Render often collapses newlines. Operators may paste a JSON-escaped string
 * (`\\n`) or a single-line PEM; both must become a parseable certificate.
 */
export function normalizePem(value: string): string {
  let pem = value.trim();
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
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
