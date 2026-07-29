import { authorizeScope } from '../auth/authorize-scope.js';
import { type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { CredentialScopeRepository, Project, ProjectRepository } from '../ports.js';
import { assertProjectReadPermission } from './assert-project-read.js';

export interface GetProjectDependencies {
  readonly projects: ProjectRepository;
  readonly credentialScopes: CredentialScopeRepository;
}

export interface GetProjectInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly projectId: string;
}

export async function getProject(
  dependencies: GetProjectDependencies,
  input: GetProjectInput,
): Promise<Project> {
  assertProjectReadPermission(input.role);

  const project = await dependencies.projects.findById(input.projectId);
  if (project === undefined) {
    throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${input.projectId} does not exist`);
  }

  await authorizeScope(
    { credentialScopes: dependencies.credentialScopes },
    {
      role: input.role,
      credentialId: input.credentialId,
      action: 'read',
      projectId: project.id,
    },
  );

  return project;
}
