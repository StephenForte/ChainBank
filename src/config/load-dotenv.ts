import { existsSync } from 'node:fs';

/**
 * Loads a local `.env` file when one is present, using Node's built-in parser
 * so no dotenv dependency is required.
 *
 * Entry points call this before reading configuration. Hosted environments
 * inject variables directly and simply have no file to load. Values already
 * present in the environment always win, so a real deployment can never be
 * overridden by a stray file.
 */
export function loadDotEnvFile(path = '.env'): void {
  if (!existsSync(path)) {
    return;
  }
  process.loadEnvFile(path);
}
