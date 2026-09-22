import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDotEnvFile } from '../../config/load-dotenv.js';
import { loadMigrateConfig } from '../../config/load-migrate-config.js';
import { describeErrorChain } from '../../domain/errors.js';
import { createLogger } from '../../observability/logger.js';
import { createDatabase, describeDatabaseTlsPin } from './client.js';

export const MIGRATIONS_FOLDER = 'drizzle';

/**
 * Applies pending migrations and exits. Render runs this as part of the deploy
 * so the schema is current before any process serves traffic.
 *
 * Only DATABASE_URL (and optional SSL / log settings) are required. Treasury
 * and email configuration are intentionally out of scope so a bad threshold
 * secret cannot block schema migration.
 */
async function main(): Promise<void> {
  loadDotEnvFile();

  const config = loadMigrateConfig();
  const logger = createLogger({
    level: config.logLevel,
    serviceRole: 'migrate',
    environment: config.environment,
  });

  logger.info(
    {
      databaseHost: safeDatabaseHost(config.database.url),
      useSsl: config.database.useSsl,
      hasSslCa: config.database.sslCertificateAuthority !== undefined,
      ...(config.database.useSsl && config.database.sslCertificateAuthority !== undefined
        ? describeDatabaseTlsPin(config.database.sslCertificateAuthority)
        : {}),
    },
    'Migration configuration loaded',
  );

  const handle = createDatabase(config.database, logger);
  try {
    // Probe first so TLS/auth failures surface as a clear driver error instead of
    // Drizzle's opaque "Failed query: CREATE SCHEMA..." wrapper.
    await handle.pool.query('select 1 as ok');
    logger.info('Database connection probe succeeded');

    logger.info('Applying database migrations');
    // Use the default "drizzle" migrations schema. An earlier hosted deploy may
    // already have recorded 0000 there; switching schemas caused a re-apply and
    // "type already exists" failures.
    await migrate(handle.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    logger.info('Database migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // Configuration loading may be the failure, so this logger cannot depend on it.
  const logger = createLogger({ level: 'error', serviceRole: 'migrate', environment: 'unknown' });
  logger.fatal({ error: describeErrorChain(error) }, 'Migration failed');
  process.exitCode = 1;
});

function safeDatabaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host;
  } catch {
    return 'unparseable';
  }
}
