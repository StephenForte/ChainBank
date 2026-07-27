import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDotEnvFile } from '../../config/load-dotenv.js';
import { loadConfig } from '../../config/index.js';
import { describeUnknownError } from '../../domain/errors.js';
import { createLogger } from '../../observability/logger.js';
import { createDatabase } from './client.js';

export const MIGRATIONS_FOLDER = 'drizzle';

/**
 * Applies pending migrations and exits. Render runs this as part of the deploy
 * so the schema is current before any process serves traffic.
 */
async function main(): Promise<void> {
  loadDotEnvFile();

  // Migrations only need database access; loading as the monitor role avoids
  // requiring email or API configuration to run them.
  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const logger = createLogger({
    level: config.app.logLevel,
    serviceRole: 'migrate',
    environment: config.app.environment,
  });

  const handle = createDatabase({ ...config.database, poolMax: 1 }, logger);
  try {
    logger.info('Applying database migrations');
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    logger.info('Database migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', message: 'Migration failed', error: describeUnknownError(error) }));
  process.exitCode = 1;
});
