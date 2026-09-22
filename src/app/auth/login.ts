import { verifyPassword, DUMMY_PASSWORD_RECORD } from '../../domain/auth/password.js';
import { generateSessionToken } from '../../domain/auth/session-token.js';
import { normalizeEmail } from '../../domain/auth/users.js';
import { ChainBankError } from '../../domain/errors.js';
import type { DashboardUserRecord, DashboardUserRepository, OperatorMutationTransaction } from '../ports.js';

/** Same sentence for an unknown email, a wrong password, and a disabled user. */
export const LOGIN_FAILURE_PUBLIC_MESSAGE = 'The email or password is not valid.';

export interface LoginDependencies {
  readonly users: DashboardUserRepository;
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly now: Date;
  readonly absoluteTtlSeconds: number;
}

export interface LoginResult {
  /** Raw session token. The caller puts it in the cookie and then forgets it. */
  readonly token: string;
}

/**
 * Checks a password and, on success, opens a session.
 *
 * An unknown email is verified against {@link DUMMY_PASSWORD_RECORD} so the
 * scrypt cost matches a real row. Disabled users take that same rejection
 * after verification, and no session row is inserted for them.
 */
export async function login(dependencies: LoginDependencies, input: LoginInput): Promise<LoginResult> {
  const user = await findForLogin(dependencies.users, input.email);
  const matches = await verifyPassword(
    input.password,
    user === undefined
      ? DUMMY_PASSWORD_RECORD
      : { passwordHash: user.passwordHash, passwordParams: user.passwordParams },
  );

  if (user === undefined || !matches || !user.enabled) {
    throw loginRejected();
  }

  const generated = generateSessionToken();
  const expiresAt = new Date(input.now.getTime() + input.absoluteTtlSeconds * 1000);

  await dependencies.operatorMutations.run(async (uow) => {
    const current = await uow.dashboardUsers.findById(user.id);
    if (current === undefined || !current.enabled) {
      throw loginRejected();
    }
    await uow.dashboardUsers.recordLogin(current.id, input.now);
    await uow.dashboardSessions.insert({
      userId: current.id,
      tokenHash: generated.tokenHash,
      createdAt: input.now,
      expiresAt,
      lastSeenAt: input.now,
    });
  });

  return { token: generated.token };
}

async function findForLogin(
  users: DashboardUserRepository,
  email: string,
): Promise<DashboardUserRecord | undefined> {
  try {
    return await users.findByEmail(normalizeEmail(email));
  } catch (error) {
    if (error instanceof ChainBankError && error.code === 'INVALID_REQUEST') {
      return undefined;
    }
    throw error;
  }
}

function loginRejected(): ChainBankError {
  return new ChainBankError('INVALID_CREDENTIAL', 'Dashboard login was rejected', {
    publicMessage: LOGIN_FAILURE_PUBLIC_MESSAGE,
  });
}
