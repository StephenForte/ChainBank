import { authorizeScope } from '../auth/authorize-scope.js';
import { type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { CredentialScopeRepository, Environment, EnvironmentRepository } from '../ports.js';
import { assertProjectReadPermission } from './assert-project-read.js';

export interface GetEnvironmentDependencies {
  readonly environments: EnvironmentRepository;
  readonly credentialScopes: CredentialScopeRepository;
}

export interface GetEnvironmentInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly environmentId: string;
}

export async function getEnvironment(
  dependencies: GetEnvironmentDependencies,
  input: GetEnvironmentInput,
): Promise<Environment> {
  assertProjectReadPermission(input.role);

  const environment = await dependencies.environments.findById(input.environmentId);
  if (environment === undefined) {
    throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} does not exist`);
  }

  await authorizeScope(
    { credentialScopes: dependencies.credentialScopes },
    {
      role: input.role,
      credentialId: input.credentialId,
      action: 'read',
      projectId: environment.projectId,
      environmentId: environment.id,
    },
  );

  return environment;
}
