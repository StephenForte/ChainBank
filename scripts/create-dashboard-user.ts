import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';
import { loadDotEnvFile } from '../src/config/load-dotenv.js';
import { assertAcceptablePassword, hashPassword } from '../src/domain/auth/password.js';
import {
  isDashboardRole,
  normalizeDisplayName,
  normalizeEmail,
  DASHBOARD_ROLES,
} from '../src/domain/auth/users.js';
import { ChainBankError, describeUnknownError } from '../src/domain/errors.js';
import { createDatabase } from '../src/infrastructure/db/client.js';
import { createOperatorMutationTransaction } from '../src/infrastructure/db/operator-mutation-transaction.js';
import { createLogger } from '../src/observability/logger.js';

/**
 * Creates the first dashboard admin (or any role) against the database.
 *
 * The password is read from stdin, never from argv or the environment, and
 * nothing secret is printed. Refuses an email that already exists — this is
 * not an upsert.
 */
async function main(): Promise<void> {
  loadDotEnvFile();

  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
    },
  });

  const emailArg = values.email;
  const nameArg = values.name;
  const roleArg = values.role;
  if (emailArg === undefined || emailArg.trim() === '') {
    throw new Error('--email is required, for example: --email operator@example.com');
  }
  if (nameArg === undefined || nameArg.trim() === '') {
    throw new Error('--name is required, for example: --name "Ada Lovelace"');
  }
  if (!isDashboardRole(roleArg)) {
    throw new Error(`--role must be one of: ${DASHBOARD_ROLES.join(', ')}`);
  }

  const email = normalizeEmail(emailArg);
  const displayName = normalizeDisplayName(nameArg);
  const password = await readPassword();
  assertAcceptablePassword(password);

  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const logger = createLogger({
    level: 'warn',
    serviceRole: 'create-dashboard-user',
    environment: config.app.environment,
  });
  const handle = createDatabase({ ...config.database, poolMax: 1 }, logger);
  const mutations = createOperatorMutationTransaction(handle.db);

  try {
    const existing = await mutations.run((uow) => uow.dashboardUsers.findByEmail(email));
    if (existing !== undefined) {
      throw new Error(`A dashboard user with email ${email} already exists (${existing.id}).`);
    }

    const hashed = await hashPassword(password);
    const now = new Date();
    const user = await mutations.run(async (uow) => {
      const created = await uow.dashboardUsers.insert({
        email,
        displayName,
        role: roleArg,
        passwordHash: hashed.passwordHash,
        passwordParams: hashed.passwordParams,
        now,
      });
      await uow.auditEvents.record({
        actorType: 'system',
        actorId: undefined,
        action: 'user.created',
        entityType: 'dashboard_user',
        entityId: created.id,
        requestId: undefined,
        sourceIp: undefined,
        metadata: { email: created.email, role: created.role, source: 'create-dashboard-user' },
      });
      return created;
    });

    console.log('');
    console.log('Dashboard user created.');
    console.log(`  id:    ${user.id}`);
    console.log(`  email: ${user.email}`);
    console.log(`  name:  ${user.displayName}`);
    console.log(`  role:  ${user.role}`);
    console.log('');
  } finally {
    await handle.close();
  }
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await new Promise((resolve) => {
        rl.question('Password: ', resolve);
      });
    } finally {
      rl.close();
    }
  }

  const parts: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    parts.push(chunk);
  }
  const text = parts.join('');
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2);
  }
  if (text.endsWith('\n')) {
    return text.slice(0, -1);
  }
  return text;
}

main().catch((error: unknown) => {
  if (error instanceof ChainBankError) {
    console.error(`Failed to create dashboard user: ${error.publicMessage}`);
  } else if (error instanceof Error) {
    console.error(`Failed to create dashboard user: ${error.message}`);
  } else {
    console.error(`Failed to create dashboard user: ${describeUnknownError(error)}`);
  }
  process.exitCode = 1;
});
