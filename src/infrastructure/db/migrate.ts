import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDotEnvFile } from '../../config/load-dotenv.js';
import { loadMigrateConfig } from '../../config/load-migrate-config.js';
import { describeUnknownError } from '../../domain/errors.js';
import { createLogger } from '../../observability/logger.js';
import { createDatabase } from './client.js';

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
    // Keep migration history in public so we do not need CREATE SCHEMA privileges
    // for a dedicated "drizzle" schema on restricted hosted roles.
    await migrate(handle.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: 'public',
    });
    logger.info('Database migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      message: 'Migration failed',
      error: describeUnknownError(error),
      cause: describeCauseChain(error),
    }),
  );
  process.exitCode = 1;
});

function safeDatabaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host;
  } catch {
    return 'unparseable';
  }
}

function describeCauseChain(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined) {
    // node-postgres / drizzle often attach detail on the error object itself.
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;
      const detail = [record.code, record.detail, record.hint]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' | ');
      return detail.length > 0 ? detail : undefined;
    }
    return undefined;
  }
  const parts: string[] = [];
  let current: unknown = error.cause;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.length === 0 ? undefined : parts.join(' | ');
}
