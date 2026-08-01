import { authorizeScope } from '../auth/authorize-scope.js';
import { type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type {
  CredentialScopeRepository,
  Environment,
  EnvironmentRepository,
  ProjectRepository,
} from '../ports.js';
import { assertProjectReadPermission } from './assert-project-read.js';

export interface ListEnvironmentsDependencies {
  readonly projects: ProjectRepository;
  readonly environments: EnvironmentRepository;
  readonly credentialScopes: CredentialScopeRepository;
}

export interface ListEnvironmentsInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly projectId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ListEnvironmentsResult {
  readonly items: readonly Environment[];
  readonly total: number;
}

export async function listEnvironments(
  dependencies: ListEnvironmentsDependencies,
  input: ListEnvironmentsInput,
): Promise<ListEnvironmentsResult> {
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

  return dependencies.environments.listByProject(project.id, {
    limit: input.limit,
    offset: input.offset,
  });
}
