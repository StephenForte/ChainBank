import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { AuditEventRepository, Treasury, TreasuryRepository } from '../ports.js';

export interface SetTreasuryEnabledDependencies {
  readonly treasuries: TreasuryRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface SetTreasuryEnabledInput {
  readonly role: Role;
  readonly treasuryId: string;
  readonly enabled: boolean;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Enables or disables a treasury row without deleting historical observations,
 * alerts, or funding records (AGENTS.md §18 per-treasury enable flag).
 *
 * Disabling the only enabled treasury for a chain is allowed: funding then
 * fails closed with TREASURY_NOT_FOUND. That is the supported path for retiring
 * a row during key rotation after a second address has been bootstrapped.
 */
export async function setTreasuryEnabled(
  dependencies: SetTreasuryEnabledDependencies,
  input: SetTreasuryEnabledInput,
): Promise<Treasury> {
  assertPermission(input.role, 'treasury:write');

  const existing = await dependencies.treasuries.findById(input.treasuryId);
  if (existing === undefined) {
    throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${input.treasuryId} does not exist`);
  }

  const treasury = await dependencies.treasuries.setEnabled(input.treasuryId, input.enabled);

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: input.enabled ? 'treasury.enabled' : 'treasury.disabled',
    entityType: 'treasury',
    entityId: treasury.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: {
      address: treasury.address,
      chainId: treasury.chain.chainId,
      previous: { enabled: existing.enabled },
      next: { enabled: treasury.enabled },
    },
  });

  return treasury;
}
