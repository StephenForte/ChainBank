import { findSupportedChainById } from '../../config/supported-chains.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import {
  ChainBankError,
  describeUnknownError,
  isChainBankError,
  type ErrorCode,
} from '../../domain/errors.js';
import type { FundingPolicy } from '../../domain/funding/funding-math.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { isUniqueViolation } from '../../shared/postgres-error.js';
import {
  chainOutcomesForDetail,
  deriveChainProcessingStatus,
  isIsolatedChainRpcFailure,
  toChainOutcomeFinding,
  type ChainRunOutcome,
} from '../alerts/chain-run-outcome.js';
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
import { replenishOperationalPrelude } from '../funding/replenish-operational-prelude.js';
import { resolveFundingTreasury } from '../../domain/treasury/resolve-treasury.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  ChainAdapterRegistry,
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
  decideNullNonceEdgeGate,
  shouldPersistOutgoingWatermarkImmediately,
  shouldSkipOutgoingBodyScan,
  type OutgoingScanWindowPlan,
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
  readonly chainAdapters: ChainAdapterRegistry;
  readonly auditEvents: AuditEventRepository;
  readonly alerts: AlertRepository;
  readonly emailSender: EmailSender | undefined;
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly reconciliationRuns: ReconciliationRunRepository;
  readonly reconciliationFunding: ReconciliationFundingQuery;
  readonly lock: FundingDispatchLock;
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
 * 3. Per configured chain, isolated from the others (C29): resolve
 *    `submission_unknown` on positive evidence; scan for crash-orphan outgoing
 *    transfers (never silently adopt); replenish; fund below-minimum wallets.
 *    An RPC failure on one chain is recorded and does not skip the rest.
 * 4. Paginate eligible wallets to completion within each chain; fund
 *    below-minimum only, serial.
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

    if (!dependencies.chainAdapters.canSign) {
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
    const wallets = await listAllEligibleWallets(dependencies.managedWallets);
    const chains = groupWorkByChain(treasuries, wallets);
    const chainOutcomes: ChainRunOutcome[] = [];
    let thrownChainFailure: ChainBankError | undefined;

    for (const chain of chains) {
      let anyScanReachedChain = false;
      let anyScanRpcUnavailable = false;
      let anyWalletObserved = false;
      let anyItemFailure = false;
      let rpcBlockedFunding = false;
      let chainErrorCode: string | undefined;
      let chainReason: string | undefined;

      try {
        for (const treasury of chain.treasuries) {
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
          if (orphanScan.chainReachable) {
            anyScanReachedChain = true;
          } else {
            anyScanRpcUnavailable = true;
          }
          unexplainedTransferCount += orphanScan.unexplained.length;
          findings.push(...orphanScan.findings);
          if (orphanScan.pendingAdvance !== undefined) {
            // Zero-finding completion is durable before the next treasury.
            // A finding stays queued until escalation has run: a crash after
            // an early advance would let the nonce gate skip the only
            // evidence of a drained treasury.
            if (
              shouldPersistOutgoingWatermarkImmediately({
                scanStatus: orphanScan.scanStatus,
                findingCount: orphanScan.findings.length,
                unexplainedCount: orphanScan.unexplained.length,
                hasPendingAdvance: true,
              })
            ) {
              await persistOutgoingWatermark(dependencies, orphanScan.pendingAdvance, input.correlationId);
            } else {
              pendingWatermarkAdvances.push(orphanScan.pendingAdvance);
            }
          }
        }

        if (dependencies.chainAdapters.externalSigner(chain.chainId) !== undefined) {
          await replenishOperationalPrelude(
            {
              treasuries: dependencies.treasuries,
              balanceObservations: dependencies.balanceObservations,
              chainAdapters: dependencies.chainAdapters,
              auditEvents: dependencies.auditEvents,
              alerts: dependencies.alerts,
              emailSender: dependencies.emailSender,
              operations: dependencies.operations,
              transactions: dependencies.transactions,
              managedWallets: dependencies.managedWallets,
              lock: dependencies.lock,
              clock: dependencies.clock,
              idGenerator: dependencies.idGenerator,
              logger: dependencies.logger,
              isFundingEnabled: dependencies.isFundingEnabled,
              isFundingKillSwitchActive: dependencies.isFundingKillSwitchActive,
              confirmations: dependencies.confirmations,
              confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
              operatorRecipients: dependencies.operatorRecipients,
              dashboardBaseUrl: dependencies.dashboardBaseUrl,
              environment: dependencies.environment,
            },
            {
              evmChainId: chain.chainId,
              role: input.role,
              credentialId: input.credentialId,
              correlationId: input.correlationId,
              sourceIp: undefined,
              idempotencyKey: `reconcile:${runId}:chain:${String(chain.chainId)}`,
            },
          );
        }

        for (const wallet of chain.wallets) {
          const treasury = resolveTreasuryForWallet(treasuries, wallet);
          if (treasury === undefined) {
            counters = addSweepOutcome(counters, 'failed');
            const reason = treasuryResolutionFailureReason(treasuries, wallet);
            findings.push({
              kind: 'wallet_assessment_failed',
              severity: 'warning',
              walletId: wallet.id,
              reason,
            });
            await recordReconcileWalletAttemptIfAbsent(dependencies, {
              wallet,
              runId,
              credentialId: input.credentialId,
              correlationId: input.correlationId,
              errorCode: 'INVALID_CONFIGURATION',
              errorSummary: reason,
            });
            logWalletFundingAttribution(dependencies.logger, {
              outcome: 'failed',
              correlationId: input.correlationId,
              runId,
              wallet,
              amountWei: 0n,
              balanceWei: undefined,
              transactionHash: undefined,
              reason,
            });
            anyItemFailure = true;
            continue;
          }

          const reserveStopped = reserveStoppedByTreasury.get(treasury.id) === true;

          try {
            const walletSigner = dependencies.chainAdapters.getSignerForTreasury(treasury);
            assertSignerMatchesTreasury(walletSigner, treasury);
            const outcome = await assessAndMaybeFundWallet(dependencies, {
              wallet,
              treasury,
              signer: walletSigner,
              runId,
              credentialId: input.credentialId,
              correlationId: input.correlationId,
              reserveStopped,
            });

            counters = addSweepOutcome(counters, outcome.counter, outcome.transferredWei);
            anyWalletObserved = true;
            // A returned `failed` is a per-item failure on a chain that answered.
            // Leaving it as `processed` would hide the failure in the chain outcome.
            if (outcome.counter === 'failed') {
              anyItemFailure = true;
            }

            if (
              outcome.counter === 'blocked' &&
              (outcome.reason === 'reserve-stop' || outcome.reason === 'missing-policy')
            ) {
              // Pre-dispatch blocks never reach dispatchFunding — write the durable
              // attempt row here. Dispatch-owned blocked/failed rows already exist.
              await recordReconcileWalletAttemptIfAbsent(dependencies, {
                wallet,
                runId,
                credentialId: input.credentialId,
                correlationId: input.correlationId,
                errorCode: reconcileAttemptErrorCode(outcome.reason),
                errorSummary: outcome.reason,
              });
            }

            if (
              outcome.counter === 'funded' ||
              outcome.counter === 'blocked' ||
              outcome.counter === 'failed'
            ) {
              logWalletFundingAttribution(dependencies.logger, {
                outcome: outcome.counter,
                correlationId: input.correlationId,
                runId,
                wallet,
                amountWei: outcome.transferredWei,
                balanceWei: outcome.resultingBalanceWei,
                transactionHash: outcome.transactionHash,
                reason: outcome.reason,
              });
            }

            if (outcome.reserveBlocked) {
              reserveStoppedByTreasury.set(treasury.id, true);
            }
          } catch (error) {
            counters = addSweepOutcome(counters, 'failed');
            anyItemFailure = true;
            const reason = error instanceof Error ? error.message : describeUnknownError(error);
            const errorCode = isChainBankError(error) ? error.code : 'INTERNAL_ERROR';
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
            await recordReconcileWalletAttemptIfAbsent(dependencies, {
              wallet,
              runId,
              credentialId: input.credentialId,
              correlationId: input.correlationId,
              errorCode,
              errorSummary: reason,
            });
            logWalletFundingAttribution(dependencies.logger, {
              outcome: 'failed',
              correlationId: input.correlationId,
              runId,
              wallet,
              amountWei: 0n,
              balanceWei: undefined,
              transactionHash: undefined,
              reason,
            });
          }
        }
      } catch (error) {
        if (!isIsolatedChainRpcFailure(error)) {
          throw error;
        }
        rpcBlockedFunding = true;
        chainErrorCode = error.code;
        chainReason = error.message;
        if (thrownChainFailure === undefined) {
          thrownChainFailure = error;
        }
        // C14: a chain whose scan never ran must not look like a clean empty
        // report. A scan that already reached the chain keeps its own finding.
        if (!anyScanReachedChain) {
          for (const treasury of chain.treasuries) {
            const alreadyRecorded = findings.some(
              (finding) => finding.kind === 'outgoing_scan_incomplete' && finding.treasuryId === treasury.id,
            );
            if (alreadyRecorded) {
              continue;
            }
            anyScanIncomplete = true;
            anyScanRpcUnavailable = true;
            findings.push({
              kind: 'outgoing_scan_incomplete',
              severity: 'critical',
              treasuryId: treasury.id,
              errorCode: error.code,
              reason: error.message,
            });
          }
        }
      }

      const status = deriveChainProcessingStatus({
        rpcBlockedFunding,
        anyWalletObserved,
        anyItemFailure,
        anyScanReachedChain,
        anyScanRpcUnavailable,
      });
      const chainOutcome: ChainRunOutcome = {
        chainId: chain.chainId,
        status,
        errorCode: chainErrorCode,
        reason: chainReason,
      };
      chainOutcomes.push(chainOutcome);
      findings.push(toChainOutcomeFinding(chainOutcome));
      if (status === 'unavailable') {
        dependencies.logger.error(
          {
            event: 'reconciliation.chain_unavailable',
            correlationId: input.correlationId,
            runId,
            chainId: chain.chainId,
            errorCode: chainErrorCode,
          },
          'Chain could not be processed; continuing other chains',
        );
      }
    }

    // Zero enabled treasuries: the scan loop body never ran — not-run, not a
    // vacuous complete (TX.9 round 2 / same class as defect 2).
    if (treasuries.length === 0) {
      outgoingScanStatus = 'not-run';
    } else {
      outgoingScanStatus = anyScanIncomplete ? 'incomplete' : 'complete';
    }

    const everyChainUnavailable =
      chainOutcomes.length > 0 && chainOutcomes.every((outcome) => outcome.status === 'unavailable');
    if (everyChainUnavailable && thrownChainFailure !== undefined) {
      // Single-chain and all-chains RPC throws keep today's run-level error
      // code, so the exit stays malfunction. A partial outage leaves
      // error_code unset and is classified from chain outcomes instead (C29).
      runErrorCode = thrownChainFailure.code;
      runErrorSummary = thrownChainFailure.publicMessage;
      dependencies.logger.error(
        {
          event: 'reconciliation.run.failed',
          correlationId: input.correlationId,
          runId,
          errorCode: runErrorCode,
          err: { message: thrownChainFailure.message, name: thrownChainFailure.name },
        },
        'Reconciliation run failed',
      );
    }

    if (runErrorCode === undefined) {
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
          chainOutcomes: chainOutcomesForDetail(chainOutcomes),
        },
      });
    }
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

  // Escalate while findings are durable and *before* watermark writes. A
  // recordOutgoingScanComplete failure must not silence the key-compromise
  // signal (TX.15 / C18) — the next run can re-scan; an unlogged finding cannot
  // be recovered from Render logs.
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

  // Findings + escalation are done; now advance watermarks that were held
  // because the scan produced a finding. A failure here leaves the next run
  // re-scanning the same window (fail closed — duplicate findings beat a
  // lost key-compromise signal). Zero-finding scans were written before the
  // next treasury and are not in this list.
  for (const advance of pendingWatermarkAdvances) {
    await persistOutgoingWatermark(dependencies, advance, input.correlationId);
  }

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
 *
 * Each finding is notified in its own try/catch so one alert-store/email
 * failure cannot suppress a later distinct incident in the same run.
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

  let treasuriesById: ReadonlyMap<string, Treasury>;
  try {
    const treasuries = await dependencies.treasuries.listEnabled();
    treasuriesById = new Map(treasuries.map((treasury) => [treasury.id, treasury]));
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
    return;
  }

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

    try {
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
    } catch (error) {
      dependencies.logger.error(
        {
          event: 'treasury.finding_alert.notification_failed',
          correlationId: input.correlationId,
          runId: input.run.runId,
          treasuryId: finding.treasuryId,
          findingKind: finding.kind,
          err:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : { message: String(error) },
        },
        'Treasury finding alert notification failed for one finding; continuing with remaining findings',
      );
    }
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

function groupWorkByChain(
  treasuries: readonly Treasury[],
  wallets: readonly ManagedWallet[],
): readonly {
  readonly chainId: number;
  readonly treasuries: readonly Treasury[];
  readonly wallets: readonly ManagedWallet[];
}[] {
  const byChain = new Map<number, { treasuries: Treasury[]; wallets: ManagedWallet[] }>();
  const bucketFor = (chainId: number): { treasuries: Treasury[]; wallets: ManagedWallet[] } => {
    const existing = byChain.get(chainId);
    if (existing !== undefined) {
      return existing;
    }
    const created = { treasuries: [], wallets: [] };
    byChain.set(chainId, created);
    return created;
  };
  for (const treasury of treasuries) {
    bucketFor(treasury.chain.chainId).treasuries.push(treasury);
  }
  for (const wallet of wallets) {
    bucketFor(wallet.chain.chainId).wallets.push(wallet);
  }
  return [...byChain.entries()].map(([chainId, group]) => ({
    chainId,
    treasuries: group.treasuries,
    wallets: group.wallets,
  }));
}

function resolveTreasuryForWallet(
  treasuries: readonly Treasury[],
  wallet: ManagedWallet,
): Treasury | undefined {
  const resolution = resolveFundingTreasury(treasuries, wallet.chain.chainId);
  return resolution.kind === 'ok' ? resolution.treasury : undefined;
}

/** C23 per-kind (or hatch) message — never a raw enabled-row count. */
function treasuryResolutionFailureReason(treasuries: readonly Treasury[], wallet: ManagedWallet): string {
  const resolution = resolveFundingTreasury(treasuries, wallet.chain.chainId);
  if (resolution.kind === 'error') {
    return resolution.error.message;
  }
  return `No enabled treasury is registered for chain ${String(wallet.chain.chainId)}`;
}

interface SweepWalletAttribution {
  readonly counter: 'funded' | 'noop' | 'blocked' | 'failed';
  readonly transferredWei: bigint;
  readonly reserveBlocked: boolean;
  /** Post-funding balance when known; pre-assessment balance for blocked/failed paths. */
  readonly resultingBalanceWei: bigint | undefined;
  readonly transactionHash: string | undefined;
  readonly reason: string | undefined;
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
): Promise<SweepWalletAttribution> {
  const walletReading = await dependencies.chainAdapters
    .balanceReader(input.wallet.chain.chainId)
    .readBalance({
      chainId: input.wallet.chain.chainId,
      address: input.wallet.addressDisplay,
    });
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
      return {
        counter: 'noop',
        transferredWei: 0n,
        reserveBlocked: false,
        resultingBalanceWei: walletReading.balanceWei,
        transactionHash: undefined,
        reason: undefined,
      };
    case 'no-op':
      return {
        counter: 'noop',
        transferredWei: 0n,
        reserveBlocked: false,
        resultingBalanceWei: walletReading.balanceWei,
        transactionHash: undefined,
        reason: undefined,
      };
    case 'blocked':
      return {
        counter: 'blocked',
        transferredWei: 0n,
        reserveBlocked: assessment.reason === 'reserve-stop',
        resultingBalanceWei: walletReading.balanceWei,
        transactionHash: undefined,
        reason: assessment.reason,
      };
    case 'needs-funding':
      break;
    default:
      return assertNever(assessment, 'SweepWalletOutcome');
  }

  const policy = requireFundingPolicy(input.wallet);

  const treasuryReading = await dependencies.chainAdapters
    .balanceReader(input.treasury.chain.chainId)
    .readBalance({
      chainId: input.treasury.chain.chainId,
      address: input.treasury.address,
    });
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
      chainAdapters: dependencies.chainAdapters,
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

  const mapped = await mapDispatchToSweepCounter(dependencies, {
    dispatchResult,
    treasury: input.treasury,
    correlationId: input.correlationId,
  });

  const resultingBalanceWei =
    mapped.counter === 'funded' ? walletReading.balanceWei + mapped.transferredWei : walletReading.balanceWei;

  return { ...mapped, resultingBalanceWei };
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
  readonly transactionHash: string | undefined;
  readonly reason: string | undefined;
}> {
  switch (input.dispatchResult.kind) {
    case 'no-op':
      return {
        counter: 'noop',
        transferredWei: 0n,
        reserveBlocked: false,
        transactionHash: undefined,
        reason: input.dispatchResult.reason,
      };
    case 'blocked':
      return {
        counter: 'blocked',
        transferredWei: 0n,
        reserveBlocked: input.dispatchResult.reason === 'reserve',
        transactionHash: undefined,
        reason: input.dispatchResult.reason,
      };
    case 'replay': {
      const tx = input.dispatchResult.transaction;
      if (tx === undefined) {
        return {
          counter: 'noop',
          transferredWei: 0n,
          reserveBlocked: false,
          transactionHash: undefined,
          reason: 'replay-without-transaction',
        };
      }
      if (tx.status === 'confirmed') {
        return {
          counter: 'funded',
          transferredWei: tx.amountWei,
          reserveBlocked: false,
          transactionHash: tx.transactionHash,
          reason: 'replay-confirmed',
        };
      }
      if (tx.status === 'submitted' || tx.status === 'created' || tx.status === 'submission_unknown') {
        // Pending counts as assessed-but-not-newly-funded for summary math.
        return {
          counter: 'noop',
          transferredWei: 0n,
          reserveBlocked: false,
          transactionHash: tx.transactionHash,
          reason: `replay-pending:${tx.status}`,
        };
      }
      return {
        counter: 'failed',
        transferredWei: 0n,
        reserveBlocked: false,
        transactionHash: tx.transactionHash,
        reason: tx.errorCode ?? `replay-terminal:${tx.status}`,
      };
    }
    case 'submitted': {
      const tracked = await trackTransaction(
        {
          operations: dependencies.operations,
          transactions: dependencies.transactions,
          receiptTracker: dependencies.chainAdapters.receiptTracker(input.treasury.chain.chainId),
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
              transactionHash: tracked.transaction.transactionHash,
              reason: undefined,
            };
          }
          return {
            counter: 'failed',
            transferredWei: 0n,
            reserveBlocked: false,
            transactionHash: tracked.transaction.transactionHash,
            reason: tracked.transaction.errorCode ?? tracked.transaction.status,
          };
        case 'pending':
          // Submitted but not yet confirmed — count as funded for sweep math
          // (a transfer was issued this run).
          return {
            counter: 'funded',
            transferredWei: tracked.transaction.amountWei,
            reserveBlocked: false,
            transactionHash: tracked.transaction.transactionHash,
            reason: 'submitted-pending-confirmation',
          };
        case 'reverted':
        case 'replaced':
        case 'dropped':
          return {
            counter: 'failed',
            transferredWei: 0n,
            reserveBlocked: false,
            transactionHash: tracked.transaction.transactionHash,
            reason: tracked.kind,
          };
        default:
          return assertNever(tracked, 'TrackTransactionResult');
      }
    }
    default:
      return assertNever(input.dispatchResult, 'DispatchFundingResult');
  }
}

/**
 * Persists a terminal reconcile attempt for wallets that never reach
 * {@link dispatchFunding} (reserve-stop pre-check, missing treasury, thrown
 * assessment errors). Same idempotency key shape as dispatch so
 * GET /health/funding can attribute per-wallet membership without a sweep-level
 * fallback.
 *
 * Best-effort relative to the sweep outcome: a record failure is logged and
 * swallowed so one DB blip cannot abort remaining wallets. Health fails closed
 * without the row (no attempt ⇒ failing for below-policy wallets).
 */
async function recordReconcileWalletAttemptIfAbsent(
  dependencies: ReconcileWalletsDependencies,
  input: {
    readonly wallet: ManagedWallet;
    readonly runId: string;
    readonly credentialId: string;
    readonly correlationId: string;
    readonly errorCode: string;
    readonly errorSummary: string;
  },
): Promise<void> {
  const idempotencyKey = reconciliationIdempotencyKey(input.runId, input.wallet.id);
  try {
    const existing = await dependencies.operations.findByIdempotencyKey(input.credentialId, idempotencyKey);
    if (existing !== undefined) {
      return;
    }

    const pending = {
      id: dependencies.idGenerator.next(),
      operationType: 'reconcile',
      projectId: input.wallet.project.id,
      environmentId: input.wallet.environment.id,
      idempotencyKey,
      requestedBy: input.credentialId,
      startedAt: dependencies.clock.now(),
    };

    let operation;
    try {
      operation = await dependencies.operations.insertPending(pending);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Concurrent insert won — durable membership already exists.
      return;
    }

    await dependencies.operations.markFailed(
      operation.id,
      input.errorCode,
      input.errorSummary,
      dependencies.clock.now(),
    );
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'reconciliation.attempt_record_failed',
        correlationId: input.correlationId,
        runId: input.runId,
        walletId: input.wallet.id,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Failed to persist reconcile attempt row; continuing sweep',
    );
  }
}

function reconcileAttemptErrorCode(reason: 'reserve-stop' | 'missing-policy'): ErrorCode {
  if (reason === 'reserve-stop') {
    return 'FUNDING_BLOCKED_RESERVE';
  }
  return 'INVALID_REQUEST';
}

/**
 * One structured line per funded / blocked / failed wallet.
 *
 * Complements (does not replace) the run-completed summary counters. Wei and
 * chain quantities are decimal strings so Pino never sees a raw bigint.
 * Addresses and tx hashes are public; never log signer material here.
 */
export function logWalletFundingAttribution(
  logger: Logger,
  input: {
    readonly outcome: 'funded' | 'blocked' | 'failed';
    readonly correlationId: string;
    readonly runId: string;
    readonly wallet: ManagedWallet;
    readonly amountWei: bigint;
    readonly balanceWei: bigint | undefined;
    readonly transactionHash: string | undefined;
    readonly reason: string | undefined;
  },
): void {
  const fields = {
    event:
      input.outcome === 'funded'
        ? ('reconciliation.wallet_funded' as const)
        : input.outcome === 'blocked'
          ? ('reconciliation.wallet_blocked' as const)
          : ('reconciliation.wallet_failed' as const),
    correlationId: input.correlationId,
    runId: input.runId,
    walletId: input.wallet.id,
    walletLabel: input.wallet.role,
    address: input.wallet.addressDisplay,
    chainId: input.wallet.chain.chainId,
    amountWei: input.amountWei.toString(),
    balanceWei: input.balanceWei === undefined ? undefined : input.balanceWei.toString(),
    transactionHash: input.transactionHash,
    reason: input.reason,
  };

  if (input.outcome === 'funded') {
    logger.info(fields, 'Reconciliation funded managed wallet');
    return;
  }
  if (input.outcome === 'blocked') {
    logger.warn(fields, 'Reconciliation blocked funding for managed wallet');
    return;
  }
  logger.error(fields, 'Reconciliation failed to fund managed wallet');
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

  const nonceResult = await outgoingScannerFor(
    dependencies,
    treasury.chain.chainId,
  ).getConfirmedTransactionCount(treasury.addressDisplay);
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
  const chain = findSupportedChainById(treasury.chain.chainId);
  if (chain === undefined) {
    return {
      kind: 'pending',
      reason: `no supported chain descriptor for chain ID ${String(treasury.chain.chainId)}`,
    };
  }
  const lookbackBlocks = nonceSearchLookbackBlocks({
    createdAt: row.createdAt,
    now: dependencies.clock.now(),
    maxBlocks: input.maxLookbackBlocks,
    blockTimeMs: chain.blockTimeMs,
  });

  const found = await outgoingScannerFor(dependencies, treasury.chain.chainId).findOutgoingByNonce({
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

  const destinationAddress = await resolveSubmissionUnknownDestination(dependencies, row);
  if (destinationAddress === undefined) {
    return {
      kind: 'pending',
      reason: 'submission_unknown row has no resolvable destination',
    };
  }

  const isOurs = isMatchingSubmissionTransfer({
    transfer: found.transfer,
    walletAddress: destinationAddress,
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
      receiptTracker: dependencies.chainAdapters.receiptTracker(treasury.chain.chainId),
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

async function resolveSubmissionUnknownDestination(
  dependencies: ReconcileWalletsDependencies,
  row: FundingTransaction,
): Promise<string | undefined> {
  if (row.destinationTreasuryId !== undefined) {
    const destination = await dependencies.treasuries.findById(row.destinationTreasuryId);
    return destination?.address;
  }
  if (row.managedWalletId === undefined) {
    return undefined;
  }
  const wallet = await dependencies.managedWallets.findById(row.managedWalletId);
  return wallet?.address;
}

function isTerminalOp(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'abandoned';
}

async function persistOutgoingWatermark(
  dependencies: ReconcileWalletsDependencies,
  advance: {
    readonly treasuryId: string;
    readonly scannedToBlock: bigint;
    readonly scannedNonce: number;
  },
  correlationId: string,
): Promise<void> {
  await dependencies.treasuries.recordOutgoingScanComplete({
    treasuryId: advance.treasuryId,
    scannedToBlock: advance.scannedToBlock,
    scannedNonce: advance.scannedNonce,
    scannedAt: dependencies.clock.now(),
  });
  dependencies.logger.info(
    {
      event: 'reconciliation.outgoing_scan.watermark_advanced',
      correlationId,
      treasuryId: advance.treasuryId,
      scannedToBlock: advance.scannedToBlock.toString(),
      scannedNonce: advance.scannedNonce,
    },
    'Treasury outgoing-scan watermark advanced',
  );
}

type CrashOrphanScan = {
  readonly scanStatus: 'complete' | 'incomplete';
  readonly chainReachable: boolean;
  readonly unexplained: readonly ReconciliationFinding[];
  readonly findings: readonly ReconciliationFinding[];
  readonly pendingAdvance:
    | {
        readonly treasuryId: string;
        readonly scannedToBlock: bigint;
        readonly scannedNonce: number;
      }
    | undefined;
};

function provenEmptyWindow(
  treasuryId: string,
  plan: Extract<OutgoingScanWindowPlan, { kind: 'scan' }>,
  nonce: number,
): CrashOrphanScan {
  const findings: ReconciliationFinding[] = [];
  if (plan.isCoverageBehind) {
    const markerBefore = plan.lastScannedBlock ?? plan.fromBlock - 1n;
    findings.push({
      kind: 'outgoing_scan_coverage_behind',
      severity: 'warning',
      treasuryId,
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
    chainReachable: true,
    unexplained: [],
    findings,
    pendingAdvance: {
      treasuryId,
      scannedToBlock: plan.advanceMarkerTo,
      scannedNonce: nonce,
    },
  };
}

function incompleteEdgeRead(treasuryId: string, errorCode: string, reason: string): CrashOrphanScan {
  return {
    scanStatus: 'incomplete',
    chainReachable: true,
    unexplained: [],
    findings: [
      {
        kind: 'outgoing_scan_incomplete',
        severity: 'critical',
        treasuryId,
        errorCode,
        reason,
      },
    ],
    pendingAdvance: undefined,
  };
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
  readonly chainReachable: boolean;
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
  const tipResult = await outgoingScannerFor(
    dependencies,
    input.treasury.chain.chainId,
  ).getLatestBlockNumber();
  if (tipResult.kind === 'unavailable') {
    const finding: ReconciliationFinding = {
      kind: 'outgoing_scan_incomplete',
      severity: 'critical',
      treasuryId: input.treasury.id,
      errorCode: tipResult.errorCode,
      reason: tipResult.reason,
    };
    // Positive-evidence discipline: leave the watermark unchanged.
    return {
      scanStatus: 'incomplete',
      chainReachable: false,
      unexplained: [],
      findings: [finding],
      pendingAdvance: undefined,
    };
  }

  const plan = planOutgoingScanWindow({
    tip: tipResult.blockNumber,
    lastScannedBlock: input.treasury.lastOutgoingScanBlock,
    maxBlocksPerRun: input.maxBlocksPerRun,
  });

  if (plan.kind === 'empty') {
    return {
      scanStatus: 'complete',
      chainReachable: true,
      unexplained: [],
      findings: [],
      pendingAdvance: undefined,
    };
  }

  // TX.14: nonce gate after plan, before the body scan. A stored nonce skips
  // when the count at plan.toBlock still equals it. Count is read at
  // plan.toBlock (not latest) so a tip that moves during the sweep cannot
  // mask a transaction inside the next window.
  // TX.34: a null stored nonce may skip when the counts at the window edges
  // are equal. fromBlock 0 cannot be proved that way and body-scans.
  const storedNonce = input.treasury.lastOutgoingScanNonce;
  let tipNonce: number | undefined;

  if (storedNonce !== undefined) {
    const countAtTip = await outgoingScannerFor(
      dependencies,
      input.treasury.chain.chainId,
    ).getTransactionCountAtBlock({
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
        return provenEmptyWindow(input.treasury.id, plan, tipNonce);
      }
    }
    // Count unavailable or nonce delta → fall through to today's full scan.
  } else if (plan.fromBlock > 0n) {
    const countBeforeWindow = await outgoingScannerFor(
      dependencies,
      input.treasury.chain.chainId,
    ).getTransactionCountAtBlock({
      address: input.treasury.addressDisplay,
      blockNumber: plan.fromBlock - 1n,
    });
    if (countBeforeWindow.kind !== 'ok') {
      return incompleteEdgeRead(input.treasury.id, countBeforeWindow.errorCode, countBeforeWindow.reason);
    }
    const countAtEnd = await outgoingScannerFor(
      dependencies,
      input.treasury.chain.chainId,
    ).getTransactionCountAtBlock({
      address: input.treasury.addressDisplay,
      blockNumber: plan.toBlock,
    });
    if (countAtEnd.kind !== 'ok') {
      return incompleteEdgeRead(input.treasury.id, countAtEnd.errorCode, countAtEnd.reason);
    }
    const decision = decideNullNonceEdgeGate({
      fromBlock: plan.fromBlock,
      countBeforeWindow: countBeforeWindow.confirmedNonce,
      countAtToBlock: countAtEnd.confirmedNonce,
      edgeReadUnavailable: false,
    });
    if (decision.kind === 'incomplete') {
      return incompleteEdgeRead(
        input.treasury.id,
        'RPC_UNAVAILABLE',
        'Transaction count at a scan-window edge could not be read from the RPC endpoint.',
      );
    }
    if (decision.kind === 'skip') {
      dependencies.logger.info(
        {
          event: 'reconciliation.outgoing_scan.skipped_null_nonce_edges',
          correlationId: input.correlationId,
          treasuryId: input.treasury.id,
          countBeforeWindow: countBeforeWindow.confirmedNonce,
          countAtToBlock: countAtEnd.confirmedNonce,
          fromBlock: plan.fromBlock.toString(),
          toBlock: plan.toBlock.toString(),
        },
        'Outgoing scan skipped: nonce unchanged across the unscanned window',
      );
      return provenEmptyWindow(input.treasury.id, plan, decision.nonce);
    }
    // Counts differ. The end count is the nonce a completed body scan records.
    tipNonce = countAtEnd.confirmedNonce;
  }

  const scan = await outgoingScannerFor(dependencies, input.treasury.chain.chainId).listOutgoingTransfers({
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
    // The tip was readable; the body scan failed. The chain was reached.
    return {
      scanStatus: 'incomplete',
      chainReachable: true,
      unexplained: [],
      findings: [finding],
      pendingAdvance: undefined,
    };
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
    const countAtTip = await outgoingScannerFor(
      dependencies,
      input.treasury.chain.chainId,
    ).getTransactionCountAtBlock({
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
        chainReachable: true,
        unexplained,
        findings,
        pendingAdvance: undefined,
      };
    }
    tipNonce = countAtTip.confirmedNonce;
  }

  // Planned advance. A zero-finding completion is written before the next
  // treasury. A finding stays queued until after escalation: dying before the
  // alert must leave this window re-scannable.
  const pendingAdvance = {
    treasuryId: input.treasury.id,
    scannedToBlock: plan.advanceMarkerTo,
    scannedNonce: tipNonce,
  };

  // Backlog remaining ⇒ incomplete: the row must not read clean while coverage
  // is behind. C15 does not page on incomplete alone.
  return {
    scanStatus: plan.isCoverageBehind ? 'incomplete' : 'complete',
    chainReachable: true,
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

function outgoingScannerFor(
  dependencies: ReconcileWalletsDependencies,
  chainId: number,
): TreasuryOutgoingScanner {
  return dependencies.chainAdapters.outgoingScanner(chainId);
}

function assertSignerMatchesTreasury(signer: TreasurySigner, treasury: Treasury): void {
  if (
    signer.chainId !== treasury.chain.chainId ||
    signer.address.toLowerCase() !== treasury.address.toLowerCase()
  ) {
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
