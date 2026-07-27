import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';
import { loadDotEnvFile } from '../src/config/load-dotenv.js';
import { isRole, ROLES } from '../src/domain/auth/roles.js';
import { describeUnknownError } from '../src/domain/errors.js';
import { createDatabase } from '../src/infrastructure/db/client.js';
import { apiCredentials } from '../src/infrastructure/db/schema.js';
import { createLogger } from '../src/observability/logger.js';
import { generateApiToken } from '../src/shared/api-token.js';

/**
 * Issues an API credential and prints the token once.
 *
 * Only the hash is stored, so a lost token cannot be recovered and must be
 * reissued. Nothing here writes the token to a log or a file.
 */
async function main(): Promise<void> {
  loadDotEnvFile();

  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
    },
  });

  const name = values.name;
  const role = values.role;

  if (name === undefined || name.trim() === '') {
    throw new Error('--name is required, for example: --name "operator-local"');
  }
  if (!isRole(role)) {
    throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }

  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const logger = createLogger({
    level: 'warn',
    serviceRole: 'issue-credential',
    environment: config.app.environment,
  });

  const handle = createDatabase({ ...config.database, poolMax: 1 }, logger);
  try {
    const generated = generateApiToken();
    const [row] = await handle.db
      .insert(apiCredentials)
      .values({
        name: name.trim(),
        role,
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });

    if (row === undefined) {
      throw new Error('Credential insert returned no row.');
    }

    console.log('');
    console.log('Credential created.');
    console.log(`  id:    ${row.id}`);
    console.log(`  name:  ${name.trim()}`);
    console.log(`  role:  ${role}`);
    console.log('');
    console.log('  token (shown once, store it in a password manager):');
    console.log(`  ${generated.token}`);
    console.log('');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Failed to issue credential: ${describeUnknownError(error)}`);
  process.exitCode = 1;
});
