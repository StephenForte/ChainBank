import type { AuthenticatedActor } from './authenticate-credential.js';
import { assertAcceptablePassword, hashPassword, verifyPassword } from '../../domain/auth/password.js';
import { ChainBankError } from '../../domain/errors.js';
import type { DashboardUserRepository, OperatorMutationTransaction } from '../ports.js';

export interface ChangePasswordDependencies {
  readonly users: DashboardUserRepository;
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface ChangePasswordInput {
  readonly actor: AuthenticatedActor;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly now: Date;
  readonly operationId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Replaces the caller's password and revokes their other sessions.
 *
 * The session that presented the current password stays valid. An API
 * credential has no password, so it is refused here rather than mapped onto
 * a user.
 */
export async function changePassword(
  dependencies: ChangePasswordDependencies,
  input: ChangePasswordInput,
): Promise<void> {
  const userId = input.actor.userId;
  const sessionId = input.actor.sessionId;
  if (input.actor.kind !== 'dashboard_user' || userId === undefined || sessionId === undefined) {
    throw new ChainBankError('INSUFFICIENT_ROLE', 'Password change requires a dashboard session', {
      publicMessage: 'Sign in with a dashboard account to change your password.',
    });
  }

  assertAcceptablePassword(input.newPassword);

  const user = await dependencies.users.findById(userId);
  if (user === undefined || !user.enabled) {
    throw new ChainBankError('INVALID_CREDENTIAL', 'Dashboard user is missing or disabled', {
      publicMessage: 'The supplied credential is not valid.',
    });
  }

  const matches = await verifyPassword(input.currentPassword, {
    passwordHash: user.passwordHash,
    passwordParams: user.passwordParams,
  });
  if (!matches) {
    throw new ChainBankError('INVALID_CREDENTIAL', 'Current password did not match', {
      publicMessage: 'The current password is not valid.',
    });
  }

  const next = await hashPassword(input.newPassword);

  await dependencies.operatorMutations.run(async (uow) => {
    const updated = await uow.dashboardUsers.update(userId, {
      passwordHash: next.passwordHash,
      passwordParams: next.passwordParams,
      updatedAt: input.now,
    });
    if (updated === undefined) {
      throw new ChainBankError('USER_NOT_FOUND', `Dashboard user ${userId} does not exist`);
    }
    await uow.dashboardSessions.revokeOthers(userId, sessionId, input.now);
    await uow.auditEvents.record({
      actorType: 'dashboard_user',
      actorId: userId,
      action: 'user.password_changed',
      entityType: 'dashboard_user',
      entityId: userId,
      requestId: input.operationId,
      sourceIp: input.sourceIp,
      metadata: { revokedOtherSessions: true },
    });
  });
}
