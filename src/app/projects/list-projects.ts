import { resolveReadableProjectIds } from '../auth/authorize-scope.js';
import { type Role } from '../../domain/auth/roles.js';
import type { CredentialScopeRepository, Project, ProjectRepository } from '../ports.js';
import { assertProjectReadPermission } from './assert-project-read.js';

export interface ListProjectsDependencies {
  readonly projects: ProjectRepository;
  readonly credentialScopes: CredentialScopeRepository;
}

export interface ListProjectsInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ListProjectsResult {
  readonly items: readonly Project[];
  readonly total: number;
}

export async function listProjects(
  dependencies: ListProjectsDependencies,
  input: ListProjectsInput,
): Promise<ListProjectsResult> {
  assertProjectReadPermission(input.role);

  const allowedProjectIds = await resolveReadableProjectIds(
    { credentialScopes: dependencies.credentialScopes },
    { role: input.role, credentialId: input.credentialId },
  );

  if (allowedProjectIds !== undefined && allowedProjectIds.length === 0) {
    return { items: [], total: 0 };
  }

  if (allowedProjectIds === undefined) {
    const page = await dependencies.projects.list({
      limit: input.limit,
      offset: input.offset,
    });
    return page;
  }

  const allAllowed = await dependencies.projects.listByIds(allowedProjectIds);
  const sorted = [...allAllowed].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const items = sorted.slice(input.offset, input.offset + input.limit);
  return { items, total: sorted.length };
}
