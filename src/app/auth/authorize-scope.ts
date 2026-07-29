import type { Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { CredentialScope, CredentialScopeRepository } from '../ports.js';

/**
 * Whether the caller may read, mutate admin resources, or fund wallets in a
 * scoped project/environment.
 *
 * `fund` is for on-demand funding (ensure-funded): operator and scoped
 * project-service only. Project/environment admin mutations stay on `mutate`.
 */
export type ScopeAction = 'read' | 'mutate' | 'fund';

export interface AuthorizeScopeInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly action: ScopeAction;
  readonly projectId: string;
  /** When set, authorization also requires access to this environment. */
  readonly environmentId?: string;
}

export interface AuthorizeScopeDependencies {
  readonly credentialScopes: CredentialScopeRepository;
}

/**
 * Decides whether an authenticated credential may access a project/environment.
 *
 * Operator: all projects and environments. Read-only: read all, mutate/fund none.
 * Project-service: read and fund only via api_credential_scopes; mutate denied.
 * Cron and other roles: deny unless handled above.
 */
export async function authorizeScope(
  dependencies: AuthorizeScopeDependencies,
  input: AuthorizeScopeInput,
): Promise<void> {
  if (input.role === 'operator') {
    return;
  }

  if (input.role === 'read-only') {
    if (input.action === 'mutate' || input.action === 'fund') {
      throw new ChainBankError(
        'INSUFFICIENT_ROLE',
        input.action === 'fund'
          ? 'Read-only credentials cannot fund wallets'
          : 'Read-only credentials cannot mutate projects or environments',
        { context: { role: input.role, action: input.action } },
      );
    }
    return;
  }

  if (input.role === 'project-service') {
    if (input.action === 'mutate') {
      throw new ChainBankError(
        'INSUFFICIENT_ROLE',
        'Project-service credentials cannot mutate projects or environments',
        { context: { role: input.role, action: input.action } },
      );
    }

    const scopes = await dependencies.credentialScopes.listByCredentialId(input.credentialId);
    if (scopes.length === 0) {
      throw scopeDenied(input, 'Credential has no project/environment scope rows');
    }

    if (input.environmentId === undefined) {
      if (!hasProjectScope(scopes, input.projectId)) {
        throw scopeDenied(input, 'Credential is not scoped to the requested project');
      }
    } else if (!hasEnvironmentScope(scopes, input.projectId, input.environmentId)) {
      throw scopeDenied(input, 'Credential is not scoped to the requested project or environment');
    }
    return;
  }

  throw new ChainBankError(
    'INSUFFICIENT_ROLE',
    `Role "${input.role}" is not permitted to access projects or environments`,
    { context: { role: input.role, action: input.action } },
  );
}

/** Pure scope membership check for environment-level access (unit tests, T2.2). */
export function hasEnvironmentScope(
  scopes: readonly CredentialScope[],
  projectId: string,
  environmentId: string,
): boolean {
  for (const scope of scopes) {
    if (scope.projectId !== projectId) {
      continue;
    }
    if (scope.environmentId === undefined) {
      return true;
    }
    if (scope.environmentId === environmentId) {
      return true;
    }
  }
  return false;
}

/** True when any scope row covers the project (including env-specific rows). */
export function hasProjectScope(scopes: readonly CredentialScope[], projectId: string): boolean {
  return scopes.some((scope) => scope.projectId === projectId);
}

/** Returns project IDs the credential may read; undefined means unrestricted (operator/read-only). */
export async function resolveReadableProjectIds(
  dependencies: AuthorizeScopeDependencies,
  input: { readonly role: Role; readonly credentialId: string },
): Promise<readonly string[] | undefined> {
  if (input.role === 'operator' || input.role === 'read-only') {
    return undefined;
  }

  if (input.role === 'project-service') {
    const scopes = await dependencies.credentialScopes.listByCredentialId(input.credentialId);
    if (scopes.length === 0) {
      return [];
    }
    return [...new Set(scopes.map((scope) => scope.projectId))];
  }

  return [];
}

function scopeDenied(input: AuthorizeScopeInput, message: string): ChainBankError {
  return new ChainBankError('SCOPE_DENIED', message, {
    context: {
      credentialId: input.credentialId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      action: input.action,
    },
  });
}
