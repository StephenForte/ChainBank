import type { BalanceReading } from '../../domain/balance-reading.js';
import { ChainBankError } from '../../domain/errors.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { evaluateTreasuryStatus } from '../../domain/treasury/treasury-status.js';
import type {
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  Treasury,
  TreasuryRepository,
} from '../ports.js';

export interface CheckTreasuryBalanceDependencies {
  readonly treasuries: TreasuryRepository;
  readonly balanceObservations: BalanceObservationRepository;
  readonly balanceReader: BalanceReader;
  readonly auditEvents: AuditEventRepository;
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
 * This is read-only. It observes and reports; it never moves funds. A failed
 * read is persisted as a failed check with status `unknown`, leaving the last
 * known balance intact, so an RPC outage can never present as an empty treasury.
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

  const reading = await dependencies.balanceReader.readBalance(treasury.address);

  if (reading.kind === 'unavailable') {
    const updated = await dependencies.treasuries.recordCheckFailure({
      treasuryId: treasury.id,
      errorCode: reading.errorCode,
      checkedAt: reading.observedAt,
    });

    await dependencies.auditEvents.record({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'treasury.check.failed',
      entityType: 'treasury',
      entityId: treasury.id,
      requestId: input.operationId,
      sourceIp: undefined,
      metadata: { errorCode: reading.errorCode, chainId: treasury.chain.chainId },
    });

    return { treasury: updated, reading };
  }

  const status = evaluateTreasuryStatus(reading.balanceWei, treasury.thresholds);

  // The observation is written before the treasury summary is updated. If the
  // process dies between the two, the ledger still holds the reading and the
  // next check reconciles the summary.
  await dependencies.balanceObservations.record({
    chainRowId: treasury.chain.id,
    walletAddress: treasury.address,
    walletType: 'treasury',
    balanceWei: reading.balanceWei,
    blockNumber: reading.blockNumber,
    observedAt: reading.observedAt,
    sourceOperationId: input.operationId,
  });

  const updated = await dependencies.treasuries.recordCheckSuccess({
    treasuryId: treasury.id,
    balanceWei: reading.balanceWei,
    status,
    observedAt: reading.observedAt,
  });

  await dependencies.auditEvents.record({
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

  return { treasury: updated, reading };
}
