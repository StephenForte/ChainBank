import { assertAcceptablePassword, hashPassword } from '../../domain/auth/password.js';
import { assertActorPermission, type ActorPermissionSource } from '../../domain/auth/roles.js';
import { normalizeDisplayName, normalizeEmail, type DashboardRole } from '../../domain/auth/users.js';
import type { DashboardUserSummary, OperatorMutationTransaction } from '../ports.js';

export interface CreateUserDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface CreateUserInput {
  readonly actor: ActorPermissionSource;
  readonly actorUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: DashboardRole;
  readonly password: string;
  readonly now: Date;
  readonly operationId: string;
  readonly sourceIp: string | undefined;
}

export async function createDashboardUser(
  dependencies: CreateUserDependencies,
  input: CreateUserInput,
): Promise<DashboardUserSummary> {
  assertActorPermission(input.actor, 'user:manage');
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName);
  assertAcceptablePassword(input.password);
  const password = await hashPassword(input.password);

  return dependencies.operatorMutations.run(async (uow) => {
    const user = await uow.dashboardUsers.insert({
      email,
      displayName,
      role: input.role,
      passwordHash: password.passwordHash,
      passwordParams: password.passwordParams,
      now: input.now,
    });
    await uow.auditEvents.record({
      actorType: 'dashboard_user',
      actorId: input.actorUserId,
      action: 'user.created',
      entityType: 'dashboard_user',
      entityId: user.id,
      requestId: input.operationId,
      sourceIp: input.sourceIp,
      metadata: {
        email: user.email,
        role: user.role,
        enabled: user.enabled,
      },
    });
    return user;
  });
}
