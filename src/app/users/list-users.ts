import { assertActorPermission } from '../../domain/auth/roles.js';
import type { ActorPermissionSource } from '../../domain/auth/roles.js';
import type { DashboardUserListPage, DashboardUserRepository } from '../ports.js';

export interface ListUsersDependencies {
  readonly users: DashboardUserRepository;
}

export async function listDashboardUsers(
  dependencies: ListUsersDependencies,
  input: {
    readonly actor: ActorPermissionSource;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<DashboardUserListPage> {
  assertActorPermission(input.actor, 'user:manage');
  return dependencies.users.list({ limit: input.limit, offset: input.offset });
}
