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

function buildSslOptions(config: DatabaseConfig): pg.PoolConfig['ssl'] {
  if (!config.useSsl) {
    return false;
  }
  // Prefer an explicit CA when available. Hosted providers such as Render
  // require TLS but their CA is often absent from the Node trust store; without
  // DATABASE_SSL_CA we still encrypt in transit and skip CA verification rather
  // than failing every migrate/boot with an opaque driver error.
  if (config.sslCertificateAuthority !== undefined) {
    return { rejectUnauthorized: true, ca: config.sslCertificateAuthority };
  }
  return { rejectUnauthorized: false };
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
