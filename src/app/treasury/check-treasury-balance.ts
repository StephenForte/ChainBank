import type { BalanceReading } from '../../domain/balance-reading.js';
import { ChainBankError } from '../../domain/errors.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { evaluateTreasuryStatus } from '../../domain/treasury/treasury-status.js';
import type { BalanceReader, OperatorMutationTransaction, Treasury, TreasuryRepository } from '../ports.js';

export interface CheckTreasuryBalanceDependencies {
  /** Pre-RPC lookup only; persistence goes through {@link operatorMutations}. */
  readonly treasuries: TreasuryRepository;
  readonly balanceReader: BalanceReader;
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface CheckTreasuryBalanceInput {
  readonly treasuryId: string;
  readonly role: Role;
  /** Correlation ID of the originating request or cron run. */
  readonly operationId: string;
  readonly actor:
    { readonly type: 'api_credential'; readonly id: string } | { readonly type: 'cron'; readonly id: string };
}

export interface CheckTreasuryBalanceResult {
  readonly treasury: Treasury;
  readonly reading: BalanceReading;
}

/**
 * Reads a treasury balance from the chain and records the outcome.
 *
 * This is read-only against the chain. It observes and reports; it never moves
 * funds. A failed read is persisted as a failed check with status `unknown`,
 * leaving the last known balance intact, so an RPC outage can never present as
 * an empty treasury.
 *
 * The RPC read stays outside the database transaction. Observation / summary
 * writes and the audit entry commit atomically (C21).
 */
export async function checkTreasuryBalance(
  dependencies: CheckTreasuryBalanceDependencies,
  input: CheckTreasuryBalanceInput,
): Promise<CheckTreasuryBalanceResult> {
  // Authorization is enforced here, in the service, not only at the route.
  assertPermission(input.role, 'treasury:check');

  const treasury = await dependencies.treasuries.findById(input.treasuryId);
  if (treasury === undefined) {
    throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${input.treasuryId} does not exist`);
  }

  // Hold no DB transaction across the RPC round trip.
  const reading = await dependencies.balanceReader.readBalance(treasury.address);

  if (reading.kind === 'unavailable') {
    const updated = await dependencies.operatorMutations.run(async (uow) => {
      const failed = await uow.treasuries.recordCheckFailure({
        treasuryId: treasury.id,
        errorCode: reading.errorCode,
        checkedAt: reading.observedAt,
      });

      await uow.auditEvents.record({
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'treasury.check.failed',
        entityType: 'treasury',
        entityId: treasury.id,
        requestId: input.operationId,
        sourceIp: undefined,
        metadata: { errorCode: reading.errorCode, chainId: treasury.chain.chainId },
      });

      return failed;
    });

    return { treasury: updated, reading };
  }

  const status = evaluateTreasuryStatus(reading.balanceWei, treasury.thresholds);

  const updated = await dependencies.operatorMutations.run(async (uow) => {
    // Observation and summary share the transaction with the audit entry so a
    // failed audit cannot leave an unaudited status change (C21). The prior
    // "observation before summary" ordering is preserved inside the txn.
    await uow.balanceObservations.record({
      chainRowId: treasury.chain.id,
      walletAddress: treasury.address,
      walletType: 'treasury',
      balanceWei: reading.balanceWei,
      blockNumber: reading.blockNumber,
      observedAt: reading.observedAt,
      sourceOperationId: input.operationId,
    });

    const success = await uow.treasuries.recordCheckSuccess({
      treasuryId: treasury.id,
      balanceWei: reading.balanceWei,
      status,
      observedAt: reading.observedAt,
    });

    await uow.auditEvents.record({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'treasury.check.succeeded',
      entityType: 'treasury',
      entityId: treasury.id,
      requestId: input.operationId,
      sourceIp: undefined,
      // The balance is recorded as a decimal string; audit metadata is JSON and
      // must not depend on bigint serialization.
      metadata: {
        balanceWei: reading.balanceWei.toString(),
        blockNumber: reading.blockNumber.toString(),
        status,
        previousStatus: treasury.status,
      },
    });

    return success;
  });

  return { treasury: updated, reading };
}
