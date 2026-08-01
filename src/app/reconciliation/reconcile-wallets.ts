import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError, isChainBankError } from '../../domain/errors.js';
import type { FundingPolicy } from '../../domain/funding/funding-math.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import {
  notifyTreasuryReserveRefusal,
  resolveTreasuryReserveAlert,
} from '../alerts/notify-treasury-reserve-alert.js';
import {
  dispatchFunding,
  provisionalTopUpAmountWei,
  type DispatchFundingResult,
} from '../funding/dispatch-funding.js';
import { trackTransaction } from '../funding/track-transaction.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  EmailSender,
  FundingDispatchLock,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  ManagedWallet,
  ManagedWalletRepository,
  ReconciliationFinding,
  ReconciliationFundingQuery,
  ReconciliationRun,
  ReconciliationRunRepository,
  TransactionReceiptTracker,
  Treasury,
  TreasuryOutgoingScanner,
  TreasuryRepository,
  TreasurySigner,
} from '../ports.js';
import {
  addSweepOutcome,
  assessWalletForSweep,
  emptySweepCounters,
  isEligibleForReconciliation,
  isMatchingSubmissionTransfer,
  reconciliationIdempotencyKey,
  type SweepCounters,
  classifyOutgoingAgainstRecords,
} from './reconciliation-decisions.js';

/** Default lookback (~2.8 days at Sepolia ~12s blocks). Documented in C14. */
export const DEFAULT_RECONCILE_OUTGOING_LOOKBACK_BLOCKS = 20_000n;

const WALLET_LIST_PAGE_SIZE = 100;

export interface ReconcileWalletsDependencies {
  readonly managedWallets: ManagedWalletRepository;
  readonly treasuries: TreasuryRepository;
  readonly balanceObservations: BalanceObservationRepository;
  readonly balanceReader: BalanceReader;
  readonly auditEvents: AuditEventRepository;
  readonly alerts: AlertRepository;
  readonly emailSender: EmailSender | undefined;
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly reconciliationRuns: ReconciliationRunRepository;
  readonly reconciliationFunding: ReconciliationFundingQuery;
  readonly outgoingScanner: TreasuryOutgoingScanner;
  readonly lock: FundingDispatchLock;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly signer: TreasurySigner | undefined;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly isFundingEnabled: boolean;
  readonly isFundingKillSwitchActive: boolean;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
  /** Override for tests; production default is {@link DEFAULT_RECONCILE_OUTGOING_LOOKBACK_BLOCKS}. */
  readonly outgoingLookbackBlocks?: bigint;
}

export interface ReconcileWalletsInput {
  readonly role: Role;
  /** Cron credential id — used as requestedBy for funding operations. */
  readonly credentialId: string;
  readonly correlationId: string;
  /** Injected run id for deterministic idempotency keys; generated when omitted. */
  readonly runId?: string;
}

export interface ReconcileWalletsResult {
  readonly run: ReconciliationRun;
  readonly counters: SweepCounters;
  readonly submissionUnknownResolved: number;
  readonly submissionUnknownLeftPending: number;
  readonly unexplainedTransferCount: number;
  readonly outgoingScanStatus: 'complete' | 'incomplete';
  readonly findings: readonly ReconciliationFinding[];
}

/**
 * Application-layer reconciliation sweep (PRD P4-US1 / P4-US2; contract C14).
 *
 * Safe to run concurrently with live API funding: every submit goes through
 * {@link dispatchFunding} (C7) and the per-treasury advisory lock.
 *
 * Order:
 * 1. Authorize `reconciliation:run` (cron-reconciler only).
 * 2. Persist a run-summary row.
 * 3. Per enabled treasury: resolve `submission_unknown` on positive evidence;
 *    scan for crash-orphan outgoing transfers (never silently adopt).
 * 4. Paginate eligible wallets to completion; fund below-minimum only, serial.
 * 5. On reserve block: notify once per treasury (C10), then continue assessing
 *    remaining wallets without submitting.
 */
export async function reconcileWallets(
  dependencies: ReconcileWalletsDependencies,
  input: ReconcileWalletsInput,
): Promise<ReconcileWalletsResult> {
  assertPermission(input.role, 'reconciliation:run');

  const runId = input.runId ?? dependencies.idGenerator.next();
  const lookbackBlocks = dependencies.outgoingLookbackBlocks ?? DEFAULT_RECONCILE_OUTGOING_LOOKBACK_BLOCKS;
  const startedAt = dependencies.clock.now();
  const runRowId = dependencies.idGenerator.next();

  const started = await dependencies.reconciliationRuns.insertStarted({
    id: runRowId,
    runId,
    requestedBy: input.credentialId,
    startedAt,
  });

  const findings: ReconciliationFinding[] = [];
  let submissionUnknownResolved = 0;
  let submissionUnknownLeftPending = 0;
  let unexplainedTransferCount = 0;
  let outgoingScanStatus: 'complete' | 'incomplete' = 'complete';
  let counters = emptySweepCounters();
  let runErrorCode: string | undefined;
  let runErrorSummary: string | undefined;

  try {
    assertFundingArmed(dependencies);

    const signer = dependencies.signer;
    if (signer === undefined) {
      throw new ChainBankError(
        'SIGNER_UNAVAILABLE',
        'Reconciliation requires a treasury signer in this process.',
        {
          publicMessage: 'Funding is unavailable because the treasury signer is not configured.',
        },
      );
    }

    const treasuries = await dependencies.treasuries.listEnabled();
    const reserveStoppedByTreasury = new Map<string, boolean>();

    for (const treasury of treasuries) {
      assertSignerMatchesTreasury(signer, treasury);

      const resolution = await resolveSubmissionUnknownForTreasury(dependencies, {
        treasury,
        lookbackBlocks,
        correlationId: input.correlationId,
      });
      submissionUnknownResolved += resolution.resolved;
      submissionUnknownLeftPending += resolution.leftPending;
      findings.push(...resolution.findings);

      const orphanScan = await detectCrashOrphansForTreasury(dependencies, {
        treasury,
        lookbackBlocks,
      });
      if (orphanScan.scanStatus === 'incomplete') {
        outgoingScanStatus = 'incomplete';
      }
      unexplainedTransferCount += orphanScan.unexplained.length;
      findings.push(...orphanScan.findings);
    }

    const wallets = await listAllEligibleWallets(dependencies.managedWallets);

    for (const wallet of wallets) {
      const treasury = resolveTreasuryForWallet(treasuries, wallet);
      if (treasury === undefined) {
        counters = addSweepOutcome(counters, 'failed');
        findings.push({
          kind: 'wallet_assessment_failed',
          severity: 'warning',
          walletId: wallet.id,
          reason:
            treasuries.filter((row) => row.chain.chainId === wallet.chain.chainId).length > 1
              ? `Ambiguous treasury configuration for chain ${String(wallet.chain.chainId)}`
              : `No enabled treasury for chain ${String(wallet.chain.chainId)}`,
        });
        continue;
      }

      const reserveStopped = reserveStoppedByTreasury.get(treasury.id) === true;

      try {
        const outcome = await assessAndMaybeFundWallet(dependencies, {
          wallet,
          treasury,
          signer,
          runId,
          credentialId: input.credentialId,
          correlationId: input.correlationId,
          reserveStopped,
        });

        counters = addSweepOutcome(counters, outcome.counter, outcome.transferredWei);

        if (outcome.reserveBlocked) {
          reserveStoppedByTreasury.set(treasury.id, true);
        }
      } catch (error) {
        counters = addSweepOutcome(counters, 'failed');
        dependencies.logger.error(
          {
            event: 'reconciliation.wallet_failed',
            correlationId: input.correlationId,
            runId,
            walletId: wallet.id,
            err:
              error instanceof Error
                ? { message: error.message, name: error.name }
                : { message: String(error) },
          },
          'Reconciliation wallet assessment failed; continuing sweep',
        );
      }
    }

    await dependencies.auditEvents.record({
      actorType: 'cron',
      actorId: input.credentialId,
      action: 'reconciliation.run.completed',
      entityType: 'reconciliation_run',
      entityId: started.id,
      requestId: input.correlationId,
      sourceIp: undefined,
      metadata: {
        runId,
        walletsAssessed: counters.assessed,
        walletsFunded: counters.funded,
        walletsNoop: counters.noop,
        walletsBlocked: counters.blocked,
        walletsFailed: counters.failed,
        weiTransferred: counters.weiTransferred.toString(),
        submissionUnknownResolved,
        submissionUnknownLeftPending,
        unexplainedTransferCount,
        outgoingScanStatus,
      },
    });
  } catch (error) {
    runErrorCode = isChainBankError(error) ? error.code : 'INTERNAL_ERROR';
    runErrorSummary = isChainBankError(error) ? error.publicMessage : 'Reconciliation run failed.';
    dependencies.logger.error(
      {
        event: 'reconciliation.run.failed',
        correlationId: input.correlationId,
        runId,
        errorCode: runErrorCode,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Reconciliation run failed',
    );
  }

  const finished = await dependencies.reconciliationRuns.markFinished({
    id: started.id,
    finishedAt: dependencies.clock.now(),
    walletsAssessed: counters.assessed,
    walletsFunded: counters.funded,
    walletsNoop: counters.noop,
    walletsBlocked: counters.blocked,
    walletsFailed: counters.failed,
    weiTransferred: counters.weiTransferred,
    submissionUnknownResolved,
    submissionUnknownLeftPending,
    unexplainedTransferCount,
    outgoingScanStatus,
    findings,
    errorCode: runErrorCode,
    errorSummary: runErrorSummary,
  });

  return {
    run: finished,
    counters,
    submissionUnknownResolved,
    submissionUnknownLeftPending,
    unexplainedTransferCount,
    outgoingScanStatus,
    findings,
  };
}

async function listAllEligibleWallets(
  managedWallets: ManagedWalletRepository,
): Promise<readonly ManagedWallet[]> {
  const eligible: ManagedWallet[] = [];
  let offset = 0;
  for (;;) {
    const page = await managedWallets.list(
      { projectId: undefined, environmentId: undefined, enabled: true },
      { limit: WALLET_LIST_PAGE_SIZE, offset },
    );
    for (const wallet of page.items) {
      if (isEligibleForReconciliation(wallet)) {
        eligible.push(wallet);
      }
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) {
      break;
    }
  }
  return eligible;
}

function resolveTreasuryForWallet(
  treasuries: readonly Treasury[],
  wallet: ManagedWallet,
): Treasury | undefined {
  const matches = treasuries.filter((row) => row.chain.chainId === wallet.chain.chainId);
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0];
}

async function assessAndMaybeFundWallet(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly wallet: ManagedWallet;
    readonly treasury: Treasury;
    readonly signer: TreasurySigner;
    readonly runId: string;
    readonly credentialId: string;
    readonly correlationId: string;
    readonly reserveStopped: boolean;
  },
): Promise<{
  readonly counter: 'funded' | 'noop' | 'blocked' | 'failed';
  readonly transferredWei: bigint;
  readonly reserveBlocked: boolean;
}> {
  const walletReading = await dependencies.balanceReader.readBalance(input.wallet.addressDisplay);
  if (walletReading.kind === 'unavailable') {
    throw new ChainBankError(walletReading.errorCode, walletReading.reason, {
      publicMessage: 'The managed wallet balance could not be read from the chain.',
      context: { managedWalletId: input.wallet.id },
    });
  }

  await dependencies.balanceObservations.record({
    chainRowId: input.wallet.chain.id,
    walletAddress: input.wallet.address,
    walletType: 'managed_wallet',
    balanceWei: walletReading.balanceWei,
    blockNumber: walletReading.blockNumber,
    observedAt: walletReading.observedAt,
    sourceOperationId: input.correlationId,
  });

  const assessment = assessWalletForSweep({
    wallet: input.wallet,
    balanceWei: walletReading.balanceWei,
    reserveStopped: input.reserveStopped,
  });

  switch (assessment.kind) {
    case 'excluded':
      // Eligible list already filtered these; treat as no-op if reached.
      return { counter: 'noop', transferredWei: 0n, reserveBlocked: false };
    case 'no-op':
      return { counter: 'noop', transferredWei: 0n, reserveBlocked: false };
    case 'blocked':
      return {
        counter: 'blocked',
        transferredWei: 0n,
        reserveBlocked: assessment.reason === 'reserve-stop',
      };
    case 'needs-funding':
      break;
    default:
      return assertNever(assessment, 'SweepWalletOutcome');
  }

  const policy = requireFundingPolicy(input.wallet);

  const treasuryReading = await dependencies.balanceReader.readBalance(input.treasury.address);
  if (treasuryReading.kind === 'unavailable') {
    throw new ChainBankError(treasuryReading.errorCode, treasuryReading.reason, {
      publicMessage: 'The treasury balance could not be read from the chain.',
      context: { treasuryId: input.treasury.id },
    });
  }

  await dependencies.balanceObservations.record({
    chainRowId: input.treasury.chain.id,
    walletAddress: input.treasury.address,
    walletType: 'treasury',
    balanceWei: treasuryReading.balanceWei,
    blockNumber: treasuryReading.blockNumber,
    observedAt: treasuryReading.observedAt,
    sourceOperationId: input.correlationId,
  });

  const dispatchResult = await dispatchFunding(
    {
      operations: dependencies.operations,
      transactions: dependencies.transactions,
      managedWallets: dependencies.managedWallets,
      lock: dependencies.lock,
      signer: input.signer,
      balanceReader: dependencies.balanceReader,
      clock: dependencies.clock,
      idGenerator: dependencies.idGenerator,
      logger: dependencies.logger,
      isFundingEnabled: dependencies.isFundingEnabled,
      isFundingKillSwitchActive: dependencies.isFundingKillSwitchActive,
    },
    {
      operationType: 'reconcile',
      projectId: input.wallet.project.id,
      environmentId: input.wallet.environment.id,
      idempotencyKey: reconciliationIdempotencyKey(input.runId, input.wallet.id),
      requestedBy: input.credentialId,
      correlationId: input.correlationId,
      treasury: {
        id: input.treasury.id,
        evmChainId: input.treasury.chain.chainId,
        enabled: input.treasury.enabled,
        reserveWei: input.treasury.thresholds.minimumReserveWei,
        address: input.treasury.addressDisplay,
        balanceWei: treasuryReading.balanceWei,
      },
      walletId: input.wallet.id,
      projectEnabled: input.wallet.project.enabled,
      environmentEnabled: input.wallet.environment.enabled,
      policy,
      walletBalanceWei: walletReading.balanceWei,
    },
  );

  await maybeNotifyReserveAlert(dependencies, {
    dispatchResult,
    wallet: input.wallet,
    treasury: input.treasury,
    treasuryBalanceWei: treasuryReading.balanceWei,
    policy,
    walletBalanceWei: walletReading.balanceWei,
    correlationId: input.correlationId,
    credentialId: input.credentialId,
  });

  return mapDispatchToSweepCounter(dependencies, {
    dispatchResult,
    treasury: input.treasury,
    correlationId: input.correlationId,
  });
}

async function mapDispatchToSweepCounter(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly treasury: Treasury;
    readonly correlationId: string;
  },
): Promise<{
  readonly counter: 'funded' | 'noop' | 'blocked' | 'failed';
  readonly transferredWei: bigint;
  readonly reserveBlocked: boolean;
}> {
  switch (input.dispatchResult.kind) {
    case 'no-op':
      return { counter: 'noop', transferredWei: 0n, reserveBlocked: false };
    case 'blocked':
      return {
        counter: 'blocked',
        transferredWei: 0n,
        reserveBlocked: input.dispatchResult.reason === 'reserve',
      };
    case 'replay': {
      const tx = input.dispatchResult.transaction;
      if (tx === undefined) {
        return { counter: 'noop', transferredWei: 0n, reserveBlocked: false };
      }
      if (tx.status === 'confirmed') {
        return { counter: 'funded', transferredWei: tx.amountWei, reserveBlocked: false };
      }
      if (tx.status === 'submitted' || tx.status === 'created' || tx.status === 'submission_unknown') {
        // Pending counts as assessed-but-not-newly-funded for summary math.
        return { counter: 'noop', transferredWei: 0n, reserveBlocked: false };
      }
      return { counter: 'failed', transferredWei: 0n, reserveBlocked: false };
    }
    case 'submitted': {
      const tracked = await trackTransaction(
        {
          operations: dependencies.operations,
          transactions: dependencies.transactions,
          receiptTracker: dependencies.receiptTracker,
          clock: dependencies.clock,
          logger: dependencies.logger,
          confirmations: dependencies.confirmations,
          confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
        },
        {
          transactionId: input.dispatchResult.transaction.id,
          correlationId: input.correlationId,
          senderAddress: input.treasury.addressDisplay,
        },
      );

      switch (tracked.kind) {
        case 'confirmed':
        case 'already-terminal':
          if (tracked.transaction.status === 'confirmed') {
            return {
              counter: 'funded',
              transferredWei: tracked.transaction.amountWei,
              reserveBlocked: false,
            };
          }
          return { counter: 'failed', transferredWei: 0n, reserveBlocked: false };
        case 'pending':
          // Submitted but not yet confirmed — count as funded for sweep math
          // (a transfer was issued this run).
          return {
            counter: 'funded',
            transferredWei: tracked.transaction.amountWei,
            reserveBlocked: false,
          };
        case 'reverted':
        case 'replaced':
        case 'dropped':
          return { counter: 'failed', transferredWei: 0n, reserveBlocked: false };
        default:
          return assertNever(tracked, 'TrackTransactionResult');
      }
    }
    default:
      return assertNever(input.dispatchResult, 'DispatchFundingResult');
  }
}

async function resolveSubmissionUnknownForTreasury(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly treasury: Treasury;
    readonly lookbackBlocks: bigint;
    readonly correlationId: string;
  },
): Promise<{
  readonly resolved: number;
  readonly leftPending: number;
  readonly findings: readonly ReconciliationFinding[];
}> {
  const rows = await dependencies.reconciliationFunding.listSubmissionUnknownByTreasury(input.treasury.id);
  const findings: ReconciliationFinding[] = [];
  let resolved = 0;
  let leftPending = 0;

  for (const row of rows) {
    const settlement = await settleSubmissionUnknownRow(dependencies, {
      row,
      treasury: input.treasury,
      lookbackBlocks: input.lookbackBlocks,
      correlationId: input.correlationId,
    });

    if (settlement.kind === 'resolved') {
      resolved += 1;
    } else {
      leftPending += 1;
      findings.push({
        kind: 'submission_unknown_unresolved',
        severity: 'warning',
        treasuryId: input.treasury.id,
        transactionId: row.id,
        nonce: row.nonce,
        reason: settlement.reason,
      });
    }
  }

  return { resolved, leftPending, findings };
}

async function settleSubmissionUnknownRow(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly row: FundingTransaction;
    readonly treasury: Treasury;
    readonly lookbackBlocks: bigint;
    readonly correlationId: string;
  },
): Promise<{ readonly kind: 'resolved' } | { readonly kind: 'pending'; readonly reason: string }> {
  const { row, treasury } = input;

  if (row.nonce === undefined) {
    return { kind: 'pending', reason: 'submission_unknown row has no recorded nonce' };
  }

  const nonceResult = await dependencies.outgoingScanner.getConfirmedTransactionCount(
    treasury.addressDisplay,
  );
  if (nonceResult.kind === 'unavailable') {
    return {
      kind: 'pending',
      reason: `confirmed nonce unavailable: ${nonceResult.errorCode}`,
    };
  }

  // Confirmed nonce is the next nonce to use; if it is still ≤ recorded, our
  // slot has not been consumed yet (C4 — leave pending).
  if (nonceResult.confirmedNonce <= row.nonce) {
    return { kind: 'pending', reason: 'account nonce has not advanced past recorded nonce' };
  }

  const found = await dependencies.outgoingScanner.findOutgoingByNonce({
    fromAddress: treasury.addressDisplay,
    nonce: row.nonce,
    lookbackBlocks: input.lookbackBlocks,
  });

  if (found.kind === 'incomplete') {
    return {
      kind: 'pending',
      reason: `nonce scan incomplete: ${found.errorCode}`,
    };
  }
  if (found.kind === 'not_found') {
    // No positive evidence within lookback — never guess a terminal state.
    return {
      kind: 'pending',
      reason: 'nonce consumed but matching transfer not found within lookback',
    };
  }

  const wallet = await dependencies.managedWallets.findById(row.managedWalletId);
  if (wallet === undefined) {
    return { kind: 'pending', reason: 'managed wallet for submission_unknown row was not found' };
  }

  const isOurs = isMatchingSubmissionTransfer({
    transfer: found.transfer,
    walletAddress: wallet.address,
    amountWei: row.amountWei,
  });

  if (!isOurs) {
    // Positive evidence a different transaction consumed the slot.
    await dependencies.transactions.markReplaced(row.id, 'TRANSACTION_REPLACED');
    const operation = await dependencies.operations.findById(row.operationId);
    if (operation !== undefined && !isTerminalOp(operation.status)) {
      await dependencies.operations.markFailed(
        operation.id,
        'TRANSACTION_REPLACED',
        'On-chain transaction was replaced.',
        dependencies.clock.now(),
      );
    }
    return { kind: 'resolved' };
  }

  // Ours: promote to submitted with the observed hash, then track receipt.
  await dependencies.transactions.markSubmitted(row.id, {
    transactionHash: found.transfer.transactionHash,
    nonce: row.nonce,
    submittedAt: dependencies.clock.now(),
  });

  await trackTransaction(
    {
      operations: dependencies.operations,
      transactions: dependencies.transactions,
      receiptTracker: dependencies.receiptTracker,
      clock: dependencies.clock,
      logger: dependencies.logger,
      confirmations: dependencies.confirmations,
      confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
    },
    {
      transactionId: row.id,
      correlationId: input.correlationId,
      senderAddress: treasury.addressDisplay,
    },
  );

  return { kind: 'resolved' };
}

function isTerminalOp(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'abandoned';
}

async function detectCrashOrphansForTreasury(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly treasury: Treasury;
    readonly lookbackBlocks: bigint;
  },
): Promise<{
  readonly scanStatus: 'complete' | 'incomplete';
  readonly unexplained: readonly ReconciliationFinding[];
  readonly findings: readonly ReconciliationFinding[];
}> {
  const scan = await dependencies.outgoingScanner.listRecentOutgoingTransfers({
    fromAddress: input.treasury.addressDisplay,
    lookbackBlocks: input.lookbackBlocks,
  });

  if (scan.kind === 'incomplete') {
    const finding: ReconciliationFinding = {
      kind: 'outgoing_scan_incomplete',
      severity: 'critical',
      treasuryId: input.treasury.id,
      errorCode: scan.errorCode,
      reason: scan.reason,
    };
    return { scanStatus: 'incomplete', unexplained: [], findings: [finding] };
  }

  const recorded = await dependencies.reconciliationFunding.listRecordedTransactionHashesByTreasury(
    input.treasury.id,
  );
  const recordedSet = new Set(recorded);
  const unexplained: ReconciliationFinding[] = [];

  for (const transfer of scan.transfers) {
    const classification = classifyOutgoingAgainstRecords(transfer, recordedSet);
    if (classification.kind === 'unexplained') {
      unexplained.push({
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: input.treasury.id,
        transactionHash: transfer.transactionHash,
        toAddress: transfer.toAddress,
        valueWei: transfer.valueWei.toString(),
        nonce: transfer.nonce,
        blockNumber: transfer.blockNumber.toString(),
      });
    }
  }

  return { scanStatus: 'complete', unexplained, findings: unexplained };
}

function requireFundingPolicy(wallet: ManagedWallet): FundingPolicy {
  if (wallet.policy === undefined) {
    throw new ChainBankError('INVALID_REQUEST', `Managed wallet ${wallet.id} has no funding policy`, {
      publicMessage: 'A funding policy must be configured before this wallet can be funded.',
      context: { managedWalletId: wallet.id },
    });
  }
  return {
    minimumBalanceWei: wallet.policy.minimumBalanceWei,
    targetBalanceWei: wallet.policy.targetBalanceWei,
    maximumTopUpWei: wallet.policy.maximumTopUpWei,
    isEnabled: true,
  };
}

function assertFundingArmed(dependencies: ReconcileWalletsDependencies): void {
  if (!dependencies.isFundingEnabled) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_ENABLED is false; refusing reconciliation.', {
      publicMessage: 'Funding is disabled.',
    });
  }
  if (dependencies.isFundingKillSwitchActive) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_KILL_SWITCH is active; refusing reconciliation.', {
      publicMessage: 'Funding is temporarily disabled.',
    });
  }
}

function assertSignerMatchesTreasury(signer: TreasurySigner, treasury: Treasury): void {
  if (signer.address.toLowerCase() !== treasury.address.toLowerCase()) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Treasury signing key does not match the configured treasury address; refusing to sign.',
      {
        publicMessage: 'Funding is unavailable because the treasury signer is misconfigured.',
        context: { treasuryId: treasury.id },
      },
    );
  }
}

async function maybeNotifyReserveAlert(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly wallet: ManagedWallet;
    readonly treasury: Treasury;
    readonly treasuryBalanceWei: bigint;
    readonly policy: FundingPolicy;
    readonly walletBalanceWei: bigint;
    readonly correlationId: string;
    readonly credentialId: string;
  },
): Promise<void> {
  const actor = { type: 'cron' as const, id: input.credentialId };

  try {
    if (input.dispatchResult.kind === 'blocked' && input.dispatchResult.reason === 'reserve') {
      const requestedAmountWei = provisionalTopUpAmountWei({
        walletBalanceWei: input.walletBalanceWei,
        policy: input.policy,
      });

      await notifyTreasuryReserveRefusal(
        {
          alerts: dependencies.alerts,
          emailSender: dependencies.emailSender,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
          logger: dependencies.logger,
        },
        {
          treasury: input.treasury,
          treasuryBalanceWei: input.treasuryBalanceWei,
          managedWalletAddressDisplay: input.wallet.addressDisplay,
          managedWalletId: input.wallet.id,
          requestedAmountWei,
          operatorRecipients: dependencies.operatorRecipients,
          dashboardBaseUrl: dependencies.dashboardBaseUrl,
          environment: dependencies.environment,
          operationId: input.correlationId,
          actor,
        },
      );
      return;
    }

    if (input.dispatchResult.kind === 'submitted') {
      await resolveTreasuryReserveAlert(
        {
          alerts: dependencies.alerts,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
        },
        {
          treasuryId: input.treasury.id,
          operationId: input.correlationId,
          actor,
        },
      );
    }
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'treasury.reserve_alert.notification_failed',
        treasuryId: input.treasury.id,
        operationId: input.correlationId,
        dispatchKind: input.dispatchResult.kind,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Reserve alert notification failed; funding outcome unchanged',
    );
  }
}
