import { existsSync } from 'node:fs';

/**
 * Opt-in database-backed suites.
 *
 * Integration and e2e tests require a local Postgres database. They do not run
 * in CI or `npm test` by default. Set CHAINBANK_RUN_INTEGRATION=true (and a
 * DATABASE_URL) when you want them.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export const integrationEnabled = process.env.CHAINBANK_RUN_INTEGRATION === 'true';

if (integrationEnabled && (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.trim() === '')) {
  throw new Error(
    'CHAINBANK_RUN_INTEGRATION=true requires DATABASE_URL. See .env.example and the README.',
  );
}
