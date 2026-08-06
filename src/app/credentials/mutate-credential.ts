import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock } from '../../domain/ports.js';
import type {
  ApiCredentialSummary,
  OperatorMutationTransaction,
  OperatorMutationUnitOfWork,
} from '../ports.js';

export type CredentialMutationAction = 'disable' | 'revoke' | 'enable';

export interface MutateCredentialDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
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
 * Disables, revokes, or re-enables an API credential.
 *
 * `disable` sets `enabled = false` and is reversible with `enable`.
 * `revoke` is terminal: it sets `enabled = false` and stamps `revoked_at`, and
 * `enable` refuses to undo it — a token believed compromised must never come
 * back through the same endpoint that took it out.
 *
 * No action may target the credential making the request. Authentication
 * rejects disabled and revoked credentials alike, so a self-mutation would
 * leave the operator locked out with no in-product way back; a second operator
 * credential is the intended recovery path.
 *
 * The credential write and its audit entry commit atomically (C21).
 */
export async function mutateCredential(
  dependencies: MutateCredentialDependencies,
  input: MutateCredentialInput,
): Promise<ApiCredentialSummary> {
  assertPermission(input.role, 'credential:write');

  if (input.credentialId === input.actorCredentialId) {
    throw new ChainBankError(
      'CREDENTIAL_SELF_MUTATION_DENIED',
      `Credential ${input.credentialId} cannot mutate itself`,
      {
        publicMessage: 'You cannot change the credential you are currently using.',
      },
    );
  }

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.apiCredentials.findById(input.credentialId);
    if (existing === undefined) {
      throw new ChainBankError('CREDENTIAL_NOT_FOUND', `Credential ${input.credentialId} does not exist`);
    }

    // Revocation is terminal. Allowing `enable` to clear it would turn the
    // compromise response into a reversible toggle, so a revoked credential can
    // only be replaced by issuing a new one.
    if (input.action === 'enable' && existing.revokedAt !== undefined) {
      throw new ChainBankError(
        'CREDENTIAL_REVOKED',
        `Credential ${input.credentialId} was revoked at ${existing.revokedAt.toISOString()} and cannot be re-enabled`,
        {
          publicMessage: 'A revoked credential cannot be re-enabled. Issue a new credential instead.',
        },
      );
    }

    const at = dependencies.clock.now();
    const credential = await applyAction(uow.apiCredentials, input.action, input.credentialId, at);

    const auditAction = AUDIT_ACTION_BY_MUTATION[input.action];
    await uow.auditEvents.record({
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
  });
}

const AUDIT_ACTION_BY_MUTATION: Readonly<Record<CredentialMutationAction, string>> = {
  disable: 'credential.disabled',
  revoke: 'credential.revoked',
  enable: 'credential.enabled',
};

/** Exhaustive so a new action cannot silently fall through to a wrong write. */
async function applyAction(
  apiCredentials: OperatorMutationUnitOfWork['apiCredentials'],
  action: CredentialMutationAction,
  credentialId: string,
  at: Date,
): Promise<ApiCredentialSummary> {
  switch (action) {
    case 'disable':
      return apiCredentials.disable(credentialId, at);
    case 'revoke':
      return apiCredentials.revoke(credentialId, at);
    case 'enable':
      return apiCredentials.enable(credentialId, at);
    default:
      return assertNever(action, 'CredentialMutationAction');
  }
}
