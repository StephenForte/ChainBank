import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import type { ApiCredentialRepository, ApiCredentialSummary, AuditEventRepository } from '../ports.js';

export type CredentialMutationAction = 'disable' | 'revoke';

export interface MutateCredentialDependencies {
  readonly apiCredentials: ApiCredentialRepository;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
}

export interface MutateCredentialInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly actorCredentialId: string;
  readonly action: CredentialMutationAction;
  readonly operationId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Disables or revokes an API credential.
 *
 * Disable sets `enabled = false` and is reversible via SQL during incidents.
 * Revoke is terminal: sets `enabled = false` and `revoked_at`, and must not
 * be applied to the credential making this request (operator self-lockout).
 */
export async function mutateCredential(
  dependencies: MutateCredentialDependencies,
  input: MutateCredentialInput,
): Promise<ApiCredentialSummary> {
  assertPermission(input.role, 'credential:write');

  if (input.credentialId === input.actorCredentialId) {
    throw new ChainBankError(
      'CREDENTIAL_SELF_MUTATION_DENIED',
      `Credential ${input.credentialId} cannot disable or revoke itself`,
      {
        publicMessage: 'You cannot disable or revoke the credential you are currently using.',
      },
    );
  }

  const existing = await dependencies.apiCredentials.findById(input.credentialId);
  if (existing === undefined) {
    throw new ChainBankError('CREDENTIAL_NOT_FOUND', `Credential ${input.credentialId} does not exist`);
  }

  const at = dependencies.clock.now();
  const credential =
    input.action === 'disable'
      ? await dependencies.apiCredentials.disable(input.credentialId, at)
      : await dependencies.apiCredentials.revoke(input.credentialId, at);

  const auditAction = input.action === 'disable' ? 'credential.disabled' : 'credential.revoked';
  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorCredentialId,
    action: auditAction,
    entityType: 'api_credential',
    entityId: credential.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: {
      name: credential.name,
      role: credential.role,
      tokenPrefix: credential.tokenPrefix,
      previous: {
        enabled: existing.enabled,
        revokedAt: existing.revokedAt?.toISOString() ?? null,
      },
      next: {
        enabled: credential.enabled,
        revokedAt: credential.revokedAt?.toISOString() ?? null,
      },
    },
  });

  return credential;
}
