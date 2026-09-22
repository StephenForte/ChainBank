import { assertAcceptablePassword, hashPassword } from '../../domain/auth/password.js';
import { assertActorPermission, type ActorPermissionSource } from '../../domain/auth/roles.js';
import type { DashboardRole } from '../../domain/auth/users.js';
import { ChainBankError } from '../../domain/errors.js';
import type { DashboardUserSummary, OperatorMutationTransaction } from '../ports.js';

export interface UpdateUserDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface UpdateUserInput {
  readonly actor: ActorPermissionSource;
  readonly actorUserId: string;
  readonly userId: string;
  readonly enabled?: boolean;
  readonly role?: DashboardRole;
  readonly password?: string;
  readonly now: Date;
  readonly operationId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Changes role, enabled, and/or password for a dashboard user.
 *
 * An admin cannot disable or demote themself: authentication would then
 * refuse the only account that can undo it. Mirrors credential self-mutation.
 */
export async function updateDashboardUser(
  dependencies: UpdateUserDependencies,
  input: UpdateUserInput,
): Promise<DashboardUserSummary> {
  assertActorPermission(input.actor, 'user:manage');

  if (input.enabled === undefined && input.role === undefined && input.password === undefined) {
    throw new ChainBankError('INVALID_REQUEST', 'Dashboard user update changed nothing', {
      publicMessage: 'Provide a role, an enabled flag, or a password.',
    });
  }

  if (input.actorUserId === input.userId) {
    const disables = input.enabled === false;
    const demotes = input.role !== undefined && input.role !== 'admin';
    if (disables || demotes) {
      throw new ChainBankError(
        'CREDENTIAL_SELF_MUTATION_DENIED',
        `Dashboard user ${input.userId} cannot disable or demote themself`,
        { publicMessage: 'You cannot disable or demote your own account.' },
      );
    }
  }

  if (input.password !== undefined) {
    assertAcceptablePassword(input.password);
  }
  const password = input.password === undefined ? undefined : await hashPassword(input.password);

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.dashboardUsers.findById(input.userId);
    if (existing === undefined) {
      throw new ChainBankError('USER_NOT_FOUND', `Dashboard user ${input.userId} does not exist`);
    }

    const updated = await uow.dashboardUsers.update(input.userId, {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(password === undefined
        ? {}
        : { passwordHash: password.passwordHash, passwordParams: password.passwordParams }),
      updatedAt: input.now,
    });
    if (updated === undefined) {
      throw new ChainBankError('USER_NOT_FOUND', `Dashboard user ${input.userId} does not exist`);
    }

    await uow.auditEvents.record({
      actorType: 'dashboard_user',
      actorId: input.actorUserId,
      action: 'user.updated',
      entityType: 'dashboard_user',
      entityId: updated.id,
      requestId: input.operationId,
      sourceIp: input.sourceIp,
      metadata: {
        passwordChanged: password !== undefined,
        previous: { role: existing.role, enabled: existing.enabled },
        next: { role: updated.role, enabled: updated.enabled },
      },
    });

    return updated;
  });
}
