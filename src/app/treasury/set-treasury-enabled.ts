import { recordedRequestActorType, type RequestAuditActorType } from '../auth/request-audit-actor.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { resolveFundingTreasury, throwTreasuryResolution } from '../../domain/treasury/resolve-treasury.js';
import type { OperatorMutationTransaction, Treasury } from '../ports.js';

export interface SetTreasuryEnabledDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface SetTreasuryEnabledInput {
  readonly role: Role;
  readonly treasuryId: string;
  readonly enabled: boolean;
  readonly operationId: string;
  readonly actorId: string;
  /** Omitted when the caller predates request-actor kinds; recorded as `api_credential`. */
  readonly actorType?: RequestAuditActorType;
  readonly sourceIp: string | undefined;
}

/**
 * Enables or disables a treasury row without deleting historical observations,
 * alerts, or funding records (AGENTS.md §18 per-treasury enable flag).
 *
 * Disabling the only enabled treasury for a chain is allowed: funding then
 * fails closed with TREASURY_NOT_FOUND. C12 rotation is disable-then-insert;
 * enabling a second row of the same kind on the same EVM chain is refused
 * with INVALID_CONFIGURATION (C23).
 *
 * The enablement write and its audit entry commit atomically (C21).
 */
export async function setTreasuryEnabled(
  dependencies: SetTreasuryEnabledDependencies,
  input: SetTreasuryEnabledInput,
): Promise<Treasury> {
  assertPermission(input.role, 'treasury:write');

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.treasuries.findById(input.treasuryId);
    if (existing === undefined) {
      throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${input.treasuryId} does not exist`);
    }

    // C23: refuse a second enabled row of the same kind on the same EVM chain
    // before the write. Re-enabling the already-enabled row is a no-op success.
    // Disabling is unrestricted so C12 rotation can retire the live row first.
    if (input.enabled && !existing.enabled) {
      const enabledRows = await uow.treasuries.listEnabled();
      const sameKindOnChain = enabledRows.filter(
        (row) => row.kind === existing.kind && row.chain.chainId === existing.chain.chainId,
      );
      if (sameKindOnChain.length > 0) {
        throwTreasuryResolution(
          resolveFundingTreasury(
            [...sameKindOnChain, { ...existing, enabled: true }],
            existing.chain.chainId,
          ),
        );
      }
    }

    const treasury = await uow.treasuries.setEnabled(input.treasuryId, input.enabled);

    await uow.auditEvents.record({
      actorType: recordedRequestActorType(input.actorType),
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
  });
}
