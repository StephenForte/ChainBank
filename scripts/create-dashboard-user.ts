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
import { createDatabase } from '../src/infrastructure/db/client.js';
import { createOperatorMutationTransaction } from '../src/infrastructure/db/operator-mutation-transaction.js';
import { createLogger } from '../src/observability/logger.js';
import { formatCliFailure } from './cli-failure.js';

/**
 * Creates the first dashboard admin (or any role) against the database.
 *
 * The password is read from stdin, never from argv or the environment, and
 * nothing secret is printed. A terminal prompt does not echo the password.
 * Refuses an email that already exists — this is not an upsert.
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
    return readSilentPassword();
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

/**
 * Reads a password from the terminal without echoing it. Restores cooked
 * mode before resolving so a later prompt is not left in raw mode.
 */
function readSilentPassword(): Promise<string> {
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('A terminal is required to type a password.'));
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  process.stdout.write('Password: ');

  return new Promise((resolve, reject) => {
    let password = '';
    const finish = (value: string | undefined, error: Error | undefined): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value ?? '');
    };
    const onData = (chunk: string): void => {
      if (chunk === '\u0003') {
        finish(undefined, new Error('Password entry cancelled'));
        return;
      }
      const end = indexOfLineEnd(chunk);
      if (end >= 0) {
        if (end > 0) {
          password += chunk.slice(0, end);
        }
        finish(password, undefined);
        return;
      }
      if (chunk === '\u007f' || chunk === '\b') {
        password = password.slice(0, -1);
        return;
      }
      password += chunk;
    };
    stdin.on('data', onData);
  });
}

function indexOfLineEnd(chunk: string): number {
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];
    if (char === '\r' || char === '\n' || char === '\u0004') {
      return index;
    }
  }
  return -1;
}

main().catch((error: unknown) => {
  console.error(
    formatCliFailure(error, {
      summary: 'Failed to create dashboard user',
      chainBankHeadline: 'publicMessage',
      otherErrorHeadline: 'message',
    }),
  );
  process.exitCode = 1;
});
