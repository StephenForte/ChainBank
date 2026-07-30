import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { ApiCredentialListPage, ApiCredentialRepository } from '../ports.js';

export interface ListCredentialsDependencies {
  readonly apiCredentials: ApiCredentialRepository;
}

export interface ListCredentialsInput {
  readonly role: Role;
  readonly limit: number;
  readonly offset: number;
}

export async function listCredentials(
  dependencies: ListCredentialsDependencies,
  input: ListCredentialsInput,
): Promise<ApiCredentialListPage> {
  assertPermission(input.role, 'credential:read');

  return dependencies.apiCredentials.list({
    limit: input.limit,
    offset: input.offset,
  });
}
