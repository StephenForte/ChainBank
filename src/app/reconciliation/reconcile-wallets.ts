import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError, isChainBankError } from '../../domain/errors.js';
import type { FundingPolicy } from '../../domain/funding/funding-math.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { maybeNotifyReconciliationFailure } from '../alerts/notify-reconciliation-failure.js';
import {
  isCriticalReconciliationFinding,
  logCriticalReconciliationFindings,
  notifyTreasuryFinding,
} from '../alerts/notify-treasury-finding.js';
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
  nonceSearchLookbackBlocks,
  planOutgoingScanWindow,
  reconciliationIdempotencyKey,
  shouldSkipOutgoingBodyScan,
  type SweepCounters,
  classifyOutgoingAgainstRecords,
} from './reconciliation-decisions.js';

/**
 * Default per-run outgoing-scan cap (~2.8 days at Sepolia ~12s blocks).
 * Meaning (TX.9): maximum blocks scanned per run, not "always scan this much".
 */
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
  /**
   * Consecutive failed runs before opening a reconciliation_failure alert (C15).
   * From RECONCILE_FAILURE_ALERT_THRESHOLD (default 3).
   */
  readonly reconcileFailureAlertThreshold: number;
  /**
   * Per-run outgoing-scan cap (TX.9). Production default is
   * {@link DEFAULT_RECONCILE_OUTGOING_LOOKBACK_BLOCKS}.
   */
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
  readonly outgoingScanStatus: 'complete' | 'incomplete' | 'not-run';
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
 * 6. After the run is marked finished: evaluate reconciliation-failure alerting
 *    (C15) in a failure-isolated hook that cannot change the run outcome.
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
  // TX.9: never claim a scan that did not run (early policy / signer exits).
  let outgoingScanStatus: 'complete' | 'incomplete' | 'not-run' = 'not-run';
  let counters = emptySweepCounters();
  let runErrorCode: string | undefined;
  let runErrorSummary: string | undefined;
  // Watermark advances are applied only after markFinished succeeds so a kill
  // between scan classification and durable findings cannot orphan a critical
  // finding above an advanced marker (TX.9 round 2).
  const pendingWatermarkAdvances: Array<{
    readonly treasuryId: string;
    readonly scannedToBlock: bigint;
    readonly scannedNonce: number;
  }> = [];

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
    let anyScanIncomplete = false;

    for (const treasury of treasuries) {
      assertSignerMatchesTreasury(signer, treasury);

      const resolution = await resolveSubmissionUnknownForTreasury(dependencies, {
        treasury,
        maxLookbackBlocks: lookbackBlocks,
        correlationId: input.correlationId,
      });
      submissionUnknownResolved += resolution.resolved;
      submissionUnknownLeftPending += resolution.leftPending;
      findings.push(...resolution.findings);

      const orphanScan = await detectCrashOrphansForTreasury(dependencies, {
        treasury,
        maxBlocksPerRun: lookbackBlocks,
        correlationId: input.correlationId,
      });
      if (orphanScan.scanStatus === 'incomplete') {
        anyScanIncomplete = true;
      }
      unexplainedTransferCount += orphanScan.unexplained.length;
      findings.push(...orphanScan.findings);
      if (orphanScan.pendingAdvance !== undefined) {
        pendingWatermarkAdvances.push(orphanScan.pendingAdvance);
      }
    }

    // Zero enabled treasuries: the scan loop body never ran — not-run, not a
    // vacuous complete (TX.9 round 2 / same class as defect 2).
    if (treasuries.length === 0) {
      outgoingScanStatus = 'not-run';
    } else {
      outgoingScanStatus = anyScanIncomplete ? 'incomplete' : 'complete';
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
    // TX.9: policy refusals are deliberate stops (C15 neutral / exit 0). Log below
    // error under a distinct event so cron-failure alerting is not poisoned.
    if (runErrorCode === 'FUNDING_DISABLED') {
      dependencies.logger.warn(
        {
          event: 'reconciliation.run.policy_disabled',
          correlationId: input.correlationId,
          runId,
          errorCode: runErrorCode,
          outgoingScanStatus,
          err:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : { message: String(error) },
        },
        'Reconciliation run stopped by funding policy',
      );
    } else {
      dependencies.logger.error(
        {
          event: 'reconciliation.run.failed',
          correlationId: input.correlationId,
          runId,
          errorCode: runErrorCode,
          err:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : { message: String(error) },
        },
        'Reconciliation run failed',
      );
    }
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

  // Findings are durable; now advance watermarks. A failure here leaves the
  // next run re-scanning the same window (fail closed — duplicate findings
  // beat a lost key-compromise signal).
  for (const advance of pendingWatermarkAdvances) {
    await dependencies.treasuries.recordOutgoingScanComplete({
      treasuryId: advance.treasuryId,
      scannedToBlock: advance.scannedToBlock,
      scannedNonce: advance.scannedNonce,
      scannedAt: dependencies.clock.now(),
    });
    dependencies.logger.info(
      {
        event: 'reconciliation.outgoing_scan.watermark_advanced',
        correlationId: input.correlationId,
        treasuryId: advance.treasuryId,
        scannedToBlock: advance.scannedToBlock.toString(),
        scannedNonce: advance.scannedNonce,
      },
      'Treasury outgoing-scan watermark advanced',
    );
  }

  // Cheap half of TX.15: surface critical findings in logs even when the run
  // is a C15 success (funded correctly / no error_code). Independent of email.
  logCriticalReconciliationFindings(dependencies.logger, {
    findings: finished.findings,
    correlationId: input.correlationId,
    runId: finished.runId,
  });

  await maybeNotifyReconciliationFailureAfterRun(dependencies, {
    run: finished,
    credentialId: input.credentialId,
    correlationId: input.correlationId,
  });

  await maybeNotifyTreasuryFindingsAfterRun(dependencies, {
    run: finished,
    credentialId: input.credentialId,
    correlationId: input.correlationId,
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

/**
 * C15 failure-isolated hook: alert-store / email errors must never change the
 * finished run's outcome or the caller's result.
 */
async function maybeNotifyReconciliationFailureAfterRun(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly run: ReconciliationRun;
    readonly credentialId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  try {
    const treasuries = await dependencies.treasuries.listEnabled();
    if (treasuries.length === 0) {
      dependencies.logger.warn(
        {
          event: 'reconciliation.failure_alert.no_treasury',
          correlationId: input.correlationId,
          runId: input.run.runId,
        },
        'Reconciliation failure alert skipped: no enabled treasury to attach the alert entity',
      );
      return;
    }

    const actor = { type: 'cron' as const, id: input.credentialId };
    for (const treasury of treasuries) {
      await maybeNotifyReconciliationFailure(
        {
          alerts: dependencies.alerts,
          reconciliationRuns: dependencies.reconciliationRuns,
          managedWallets: dependencies.managedWallets,
          emailSender: dependencies.emailSender,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
          logger: dependencies.logger,
        },
        {
          run: input.run,
          treasury,
          failureAlertThreshold: dependencies.reconcileFailureAlertThreshold,
          operatorRecipients: dependencies.operatorRecipients,
          dashboardBaseUrl: dependencies.dashboardBaseUrl,
          environment: dependencies.environment,
          operationId: input.correlationId,
          actor,
        },
      );
    }
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'reconciliation.failure_alert.notification_failed',
        correlationId: input.correlationId,
        runId: input.run.runId,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Reconciliation failure alert notification failed; run outcome unchanged',
    );
  }
}

/**
 * C18 failure-isolated hook: critical finding alerts must never change the
 * finished run's outcome, C15 classification, or cron exit code.
 */
async function maybeNotifyTreasuryFindingsAfterRun(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly run: ReconciliationRun;
    readonly credentialId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  const criticalFindings = input.run.findings.filter(isCriticalReconciliationFinding);
  if (criticalFindings.length === 0) {
    return;
  }

  try {
    const treasuries = await dependencies.treasuries.listEnabled();
    const treasuriesById = new Map(treasuries.map((treasury) => [treasury.id, treasury]));
    const actor = { type: 'cron' as const, id: input.credentialId };

    for (const finding of criticalFindings) {
      const treasury = treasuriesById.get(finding.treasuryId);
      if (treasury === undefined) {
        dependencies.logger.warn(
          {
            event: 'treasury.finding_alert.treasury_missing',
            correlationId: input.correlationId,
            runId: input.run.runId,
            treasuryId: finding.treasuryId,
            findingKind: finding.kind,
          },
          'Treasury finding alert skipped: finding treasury is not in the enabled set',
        );
        continue;
      }

      await notifyTreasuryFinding(
        {
          alerts: dependencies.alerts,
          emailSender: dependencies.emailSender,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
          logger: dependencies.logger,
        },
        {
          finding,
          treasury,
          runId: input.run.runId,
          operatorRecipients: dependencies.operatorRecipients,
          dashboardBaseUrl: dependencies.dashboardBaseUrl,
          environment: dependencies.environment,
          operationId: input.correlationId,
          actor,
        },
      );
    }
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'treasury.finding_alert.notification_failed',
        correlationId: input.correlationId,
        runId: input.run.runId,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Treasury finding alert notification failed; run outcome unchanged',
    );
  }
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
    readonly maxLookbackBlocks: bigint;
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
      maxLookbackBlocks: input.maxLookbackBlocks,
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
    readonly maxLookbackBlocks: bigint;
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

  // TX.9: nonce hunt is age-bounded from the row's createdAt, not the
  // incremental crash-orphan watermark (which may post-date the broadcast).
  const lookbackBlocks = nonceSearchLookbackBlocks({
    createdAt: row.createdAt,
    now: dependencies.clock.now(),
    maxBlocks: input.maxLookbackBlocks,
  });

  const found = await dependencies.outgoingScanner.findOutgoingByNonce({
    fromAddress: treasury.addressDisplay,
    nonce: row.nonce,
    lookbackBlocks,
  });

  if (found.kind === 'incomplete') {
    return {
      kind: 'pending',
      reason: `nonce scan incomplete: ${found.errorCode}`,
    };
  }
  if (found.kind === 'not_found') {
    // No positive evidence within the searched window — never guess a terminal state.
    return {
      kind: 'pending',
      reason: 'nonce consumed but matching transfer not found within searched window',
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
    readonly maxBlocksPerRun: bigint;
    readonly correlationId: string;
  },
): Promise<{
  readonly scanStatus: 'complete' | 'incomplete';
  readonly unexplained: readonly ReconciliationFinding[];
  readonly findings: readonly ReconciliationFinding[];
  readonly pendingAdvance:
    | {
        readonly treasuryId: string;
        readonly scannedToBlock: bigint;
        readonly scannedNonce: number;
      }
    | undefined;
}> {
  const tipResult = await dependencies.outgoingScanner.getLatestBlockNumber();
  if (tipResult.kind === 'unavailable') {
    const finding: ReconciliationFinding = {
      kind: 'outgoing_scan_incomplete',
      severity: 'critical',
      treasuryId: input.treasury.id,
      errorCode: tipResult.errorCode,
      reason: tipResult.reason,
    };
    // Positive-evidence discipline: leave the watermark unchanged.
    return { scanStatus: 'incomplete', unexplained: [], findings: [finding], pendingAdvance: undefined };
  }

  const plan = planOutgoingScanWindow({
    tip: tipResult.blockNumber,
    lastScannedBlock: input.treasury.lastOutgoingScanBlock,
    maxBlocksPerRun: input.maxBlocksPerRun,
  });

  if (plan.kind === 'empty') {
    return {
      scanStatus: 'complete',
      unexplained: [],
      findings: [],
      pendingAdvance: undefined,
    };
  }

  // TX.14: nonce gate after plan, before the body scan. Null stored nonce never
  // skips. Count is read at plan.toBlock (not latest) so a tip that moves during
  // the sweep cannot mask a transaction inside the next window.
  const storedNonce = input.treasury.lastOutgoingScanNonce;
  let tipNonce: number | undefined;

  if (storedNonce !== undefined) {
    const countAtTip = await dependencies.outgoingScanner.getTransactionCountAtBlock({
      address: input.treasury.addressDisplay,
      blockNumber: plan.toBlock,
    });
    if (countAtTip.kind === 'ok') {
      tipNonce = countAtTip.confirmedNonce;
      if (shouldSkipOutgoingBodyScan({ storedNonce, tipNonce })) {
        dependencies.logger.info(
          {
            event: 'reconciliation.outgoing_scan.skipped_nonce_gate',
            correlationId: input.correlationId,
            treasuryId: input.treasury.id,
            storedNonce,
            tipNonce,
            fromBlock: plan.fromBlock.toString(),
            toBlock: plan.toBlock.toString(),
          },
          'Outgoing scan skipped: treasury nonce unchanged since watermark',
        );

        const findings: ReconciliationFinding[] = [];
        if (plan.isCoverageBehind) {
          const markerBefore = plan.lastScannedBlock ?? plan.fromBlock - 1n;
          findings.push({
            kind: 'outgoing_scan_coverage_behind',
            severity: 'warning',
            treasuryId: input.treasury.id,
            lastScannedBlock: markerBefore.toString(),
            scannedFromBlock: plan.fromBlock.toString(),
            scannedToBlock: plan.toBlock.toString(),
            tip: plan.tip.toString(),
            blocksRemaining: plan.blocksRemaining.toString(),
            reason:
              'Outgoing scan backlog exceeds the per-run cap; advanced forward-contiguously and coverage remains behind the tip.',
          });
        }

        // Proven-empty window is a complete scan of the plan; backlog still
        // reports incomplete while tip coverage remains behind (TX.9).
        return {
          scanStatus: plan.isCoverageBehind ? 'incomplete' : 'complete',
          unexplained: [],
          findings,
          pendingAdvance: {
            treasuryId: input.treasury.id,
            scannedToBlock: plan.advanceMarkerTo,
            scannedNonce: tipNonce,
          },
        };
      }
    }
    // Count unavailable or nonce delta → fall through to today's full scan.
  }

  const scan = await dependencies.outgoingScanner.listOutgoingTransfers({
    fromAddress: input.treasury.addressDisplay,
    fromBlock: plan.fromBlock,
    toBlock: plan.toBlock,
  });

  if (scan.kind === 'incomplete') {
    const finding: ReconciliationFinding = {
      kind: 'outgoing_scan_incomplete',
      severity: 'critical',
      treasuryId: input.treasury.id,
      errorCode: scan.errorCode,
      reason: scan.reason,
    };
    // Partial / failed scan must not advance the marker (C14 / TX.9).
    return { scanStatus: 'incomplete', unexplained: [], findings: [finding], pendingAdvance: undefined };
  }

  const findings: ReconciliationFinding[] = [];
  if (plan.isCoverageBehind) {
    // Invariant: first-run plans never set isCoverageBehind.
    const markerBefore = plan.lastScannedBlock ?? plan.fromBlock - 1n;
    findings.push({
      kind: 'outgoing_scan_coverage_behind',
      severity: 'warning',
      treasuryId: input.treasury.id,
      lastScannedBlock: markerBefore.toString(),
      scannedFromBlock: plan.fromBlock.toString(),
      scannedToBlock: plan.toBlock.toString(),
      tip: plan.tip.toString(),
      blocksRemaining: plan.blocksRemaining.toString(),
      reason:
        'Outgoing scan backlog exceeds the per-run cap; advanced forward-contiguously and coverage remains behind the tip.',
    });
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
  findings.push(...unexplained);

  // Seed / refresh tip nonce for the watermark write. Prefer the gate read when
  // present (toBlock is immutable for this plan); otherwise read now. Fail closed
  // on unavailability — do not advance block without a durable nonce.
  if (tipNonce === undefined) {
    const countAtTip = await dependencies.outgoingScanner.getTransactionCountAtBlock({
      address: input.treasury.addressDisplay,
      blockNumber: plan.toBlock,
    });
    if (countAtTip.kind !== 'ok') {
      findings.push({
        kind: 'outgoing_scan_incomplete',
        severity: 'critical',
        treasuryId: input.treasury.id,
        errorCode: countAtTip.errorCode,
        reason: countAtTip.reason,
      });
      return {
        scanStatus: 'incomplete',
        unexplained,
        findings,
        pendingAdvance: undefined,
      };
    }
    tipNonce = countAtTip.confirmedNonce;
  }

  // Planned advance only — flushed after markFinished so findings are durable first.
  const pendingAdvance = {
    treasuryId: input.treasury.id,
    scannedToBlock: plan.advanceMarkerTo,
    scannedNonce: tipNonce,
  };

  // Backlog remaining ⇒ incomplete: the row must not read clean while coverage
  // is behind. C15 does not page on incomplete alone.
  return {
    scanStatus: plan.isCoverageBehind ? 'incomplete' : 'complete',
    unexplained,
    findings,
    pendingAdvance,
  };
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
