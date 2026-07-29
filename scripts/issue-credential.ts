import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';
import { loadDotEnvFile } from '../src/config/load-dotenv.js';
import { isRole, ROLES } from '../src/domain/auth/roles.js';
import { ChainBankError, describeUnknownError } from '../src/domain/errors.js';
import { createDatabase } from '../src/infrastructure/db/client.js';
import { createCredentialScopeRepository } from '../src/infrastructure/db/repositories/credential-scope-repository.js';
import { apiCredentials } from '../src/infrastructure/db/schema.js';
import { createLogger } from '../src/observability/logger.js';
import { generateApiToken } from '../src/shared/api-token.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ParsedScope {
  readonly projectId: string;
  readonly environmentId: string | undefined;
}

/**
 * Issues an API credential and prints the token once.
 *
 * Only the hash is stored, so a lost token cannot be recovered and must be
 * reissued. Nothing here writes the token to a file or structured log.
 *
 * Optional repeatable `--scope` attaches project/environment rows for
 * project-service credentials (D10). Format: `<project-uuid>` or
 * `<project-uuid>:<environment-uuid>`.
 */
async function main(): Promise<void> {
  loadDotEnvFile();

  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
      scope: { type: 'string', multiple: true },
    },
  });

  const name = values.name;
  const role = values.role;
  const scopeArgs = values.scope ?? [];

  if (name === undefined || name.trim() === '') {
    throw new Error('--name is required, for example: --name "operator-local"');
  }
  if (!isRole(role)) {
    throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }

  const scopes = scopeArgs.map(parseScopeArgument);

  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const logger = createLogger({
    level: 'warn',
    serviceRole: 'issue-credential',
    environment: config.app.environment,
  });

  const handle = createDatabase({ ...config.database, poolMax: 1 }, logger);
  const credentialScopes = createCredentialScopeRepository(handle.db);

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

    for (const scope of scopes) {
      await credentialScopes.insert({
        credentialId: row.id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      });
    }

    console.log('');
    console.log('Credential created.');
    console.log(`  id:    ${row.id}`);
    console.log(`  name:  ${name.trim()}`);
    console.log(`  role:  ${role}`);
    if (scopes.length > 0) {
      console.log(`  scopes: ${String(scopes.length)} row(s) attached`);
    }
    console.log('');
    console.log('  token (shown once, store it in a password manager):');
    console.log(`  ${generated.token}`);
    console.log('');
  } finally {
    await handle.close();
  }
}

function parseScopeArgument(raw: string): ParsedScope {
  const trimmed = raw.trim();
  const parts = trimmed.split(':');
  if (parts.length > 2) {
    throw new Error(`Invalid --scope "${raw}". Use <project-uuid> or <project-uuid>:<environment-uuid>.`);
  }

  const projectId = parts[0];
  if (projectId === undefined || !UUID_PATTERN.test(projectId)) {
    throw new Error(`Invalid project UUID in --scope "${raw}".`);
  }

  const environmentPart = parts[1];
  if (environmentPart === undefined) {
    return { projectId, environmentId: undefined };
  }
  if (!UUID_PATTERN.test(environmentPart)) {
    throw new Error(`Invalid environment UUID in --scope "${raw}".`);
  }

  return { projectId, environmentId: environmentPart };
}

main().catch((error: unknown) => {
  if (error instanceof ChainBankError) {
    console.error(`Failed to issue credential: ${error.message}`);
  } else {
    console.error(`Failed to issue credential: ${describeUnknownError(error)}`);
  }
  process.exitCode = 1;
});
