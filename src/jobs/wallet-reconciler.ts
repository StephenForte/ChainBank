import { pathToFileURL } from 'node:url';
import { registerConfiguredTreasuries } from '../app/bootstrap/register-configured-treasury.js';
import {
  chainOutcomesForDetail,
  chainOutcomesFromFindings,
  exitKindForPartialChainOutage,
  isPartialChainOutage,
  type ChainRunOutcome,
} from '../app/alerts/chain-run-outcome.js';
import { proveConfiguredChainIds } from '../app/health/prove-configured-chain-ids.js';
import { recordHeartbeat } from '../app/health/record-heartbeat.js';
import {
  reconcileWallets,
  type ReconcileWalletsDependencies,
  type ReconcileWalletsResult,
} from '../app/reconciliation/reconcile-wallets.js';
import type { ReconciliationRun } from '../app/ports.js';
import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer, type Container } from '../container.js';
import {
  ChainBankError,
  describeErrorChain,
  describeUnknownError,
  isChainBankError,
} from '../domain/errors.js';
import type { Logger } from '../observability/logger.js';

/** Config / process role — signing-capable; receives TREASURY_PRIVATE_KEY. */
const SERVICE_ROLE = 'cron-reconciler' as const;

/**
 * Heartbeat key written to `service_heartbeats` / `/health/ready`.
 * Distinct from the config role so readiness lists `wallet-reconciler` next to
 * `web` and `treasury-monitor` (P0-US2 shared-DB proof).
 */
export const HEARTBEAT_SERVICE_ROLE = 'wallet-reconciler';

/** Actor / requestedBy identity for funding operations created by this cron. */
const CRON_CREDENTIAL_ID = 'wallet-reconciler';

/**
 * Exit classification for a finished reconciliation run (T4.2, amended C29).
 *
 * - `success` / `policy-disabled` → process exit 0 (Render must not page)
 * - `malfunction` → process exit 1 (DB/RPC/signer/unhandled run-level failure,
 *   or a partial chain outage)
 *
 * `FUNDING_DISABLED` (including kill switch) is policy, not malfunction: a kill
 * switch left on for a week must not produce twenty-eight failed-run pages.
 *
 * A partial chain outage — one chain processed, another unavailable, and no
 * run-level error code — uses {@link exitKindForPartialChainOutage}. A single
 * configured chain with no error code stays success.
 */
export type ReconcilerExitKind = 'success' | 'policy-disabled' | 'malfunction';

export function classifyReconcilerExit(
  errorCode: string | undefined,
  chainOutcomes: readonly ChainRunOutcome[] = [],
): ReconcilerExitKind {
  if (errorCode === undefined) {
    return isPartialChainOutage(chainOutcomes) ? exitKindForPartialChainOutage() : 'success';
  }
  if (errorCode === 'FUNDING_DISABLED') {
    return 'policy-disabled';
  }
  return 'malfunction';
}

export function reconcilerExitCode(kind: ReconcilerExitKind): 0 | 1 {
  return kind === 'malfunction' ? 1 : 0;
}

export interface WalletReconcilerRunResult {
  readonly exitKind: ReconcilerExitKind;
  readonly exitCode: 0 | 1;
  readonly reconcileResult: ReconcileWalletsResult | undefined;
}

/**
 * Builds use-case dependencies from the composition root.
 * Exposed for tests that swap EVM fakes while keeping real DB repositories.
 */
export function buildReconcileWalletsDependencies(
  container: Container,
  overrides: Partial<ReconcileWalletsDependencies> = {},
): ReconcileWalletsDependencies {
  const { config } = container;
  if (config.reconciliation === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'cron-reconciler requires reconciliation configuration (lookback blocks)',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return {
    managedWallets: container.repositories.managedWallets,
    treasuries: container.repositories.treasuries,
    balanceObservations: container.repositories.balanceObservations,
    chainAdapters: container.chainAdapters,
    auditEvents: container.repositories.auditEvents,
    alerts: container.repositories.alerts,
    emailSender: container.emailSender,
    operations: container.repositories.fundingOperations,
    transactions: container.repositories.fundingTransactions,
    reconciliationRuns: container.repositories.reconciliationRuns,
    reconciliationFunding: container.repositories.reconciliationFunding,
    lock: container.fundingDispatchLock,
    clock: container.clock,
    idGenerator: container.idGenerator,
    logger: container.logger,
    isFundingEnabled: config.isFundingEnabled,
    isFundingKillSwitchActive: config.isFundingKillSwitchActive,
    confirmations: config.funding.confirmations,
    confirmationTimeoutMs: config.funding.confirmationTimeoutMs,
    operatorRecipients: config.email?.operatorRecipients ?? [],
    dashboardBaseUrl: config.app.publicBaseUrl,
    environment: config.app.environment,
    reconcileFailureAlertThreshold: config.alerts.reconcileFailureAlertThreshold,
    outgoingLookbackBlocks: BigInt(config.reconciliation.outgoingLookbackBlocks),
    ...overrides,
  };
}

const ABORTED_RUN_LOG_MESSAGE = 'Prior reconciliation runs aborted before finish';

const UNFINISHED_RUN_NOTE = 'finished_at IS NULL — treat as aborted, not a clean complete scan';

/**
 * Surfaces rows left with `finished_at IS NULL` from a prior crash, and marks
 * the ones outside the grace window so the warning does not repeat forever.
 *
 * Runs inside the grace window are still in flight (or a concurrent instance)
 * and are warned about but not marked. Marking sets `finished_at`,
 * `error_code` (`RUN_ABORTED`), and `error_summary` only — counters, findings,
 * `outgoing_scan_status`, and `started_at` stay as they were (AGENTS.md §9).
 *
 * Called before the current run row is inserted. The id in the summary is
 * this process's correlation id; the new run's `runId` does not exist yet.
 */
export async function logAbortedReconciliationRuns(
  container: Container,
  correlationId: string,
): Promise<number> {
  const reconciliation = container.config.reconciliation;
  if (reconciliation === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'cron-reconciler requires reconciliation configuration to mark aborted runs',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const now = container.clock.now();
  const graceMs = reconciliation.abortedRunGraceMinutes * 60 * 1000;
  const graceCutoff = new Date(now.getTime() - graceMs);
  const unfinished = await container.repositories.reconciliationRuns.listAborted(now);
  const toMark = unfinished.filter((row) => row.startedAt.getTime() < graceCutoff.getTime());
  const inWindow = unfinished.filter((row) => row.startedAt.getTime() >= graceCutoff.getTime());

  let markedCount = 0;
  if (toMark.length > 0) {
    const marked = await container.repositories.reconciliationRuns.markAborted({
      ids: toMark.map((row) => row.id),
      finishedAt: now,
      errorSummary: `Process exited before finish; marked aborted at startup by run ${correlationId}`,
    });
    markedCount = marked.length;
    if (markedCount > 0) {
      container.logger.warn(
        {
          correlationId,
          abortedCount: markedCount,
          markedAborted: true,
          abortedRuns: marked.map((row) =>
            abortedRunLogFields(row, 'marked RUN_ABORTED; counters and scan status left unchanged'),
          ),
        },
        ABORTED_RUN_LOG_MESSAGE,
      );
    }
  }

  if (inWindow.length > 0) {
    container.logger.warn(
      {
        correlationId,
        abortedCount: inWindow.length,
        markedAborted: false,
        abortedRuns: inWindow.map((row) => abortedRunLogFields(row, UNFINISHED_RUN_NOTE)),
      },
      ABORTED_RUN_LOG_MESSAGE,
    );
  }

  return markedCount + inWindow.length;
}

function abortedRunLogFields(
  row: ReconciliationRun,
  note: string,
): {
  readonly id: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly outgoingScanStatus: ReconciliationRun['outgoingScanStatus'];
  readonly errorCode: string | undefined;
  readonly note: string;
} {
  return {
    id: row.id,
    runId: row.runId,
    startedAt: row.startedAt.toISOString(),
    outgoingScanStatus: row.outgoingScanStatus,
    errorCode: row.errorCode,
    note,
  };
}

/**
 * Six-hourly managed-wallet reconciliation with signing capability.
 *
 * Loads the `cron-reconciler` config role (DB, chain/RPC, funding/signer,
 * thresholds, email for T4.3 alerting), runs `reconcileWallets`, records a
 * `wallet-reconciler` heartbeat, and closes the pool before exit.
 */
export async function runWalletReconciler(
  container: Container,
  correlationId: string,
  options: {
    readonly reconcileDeps?: ReconcileWalletsDependencies;
  } = {},
): Promise<WalletReconcilerRunResult> {
  const { config, logger } = container;

  if (container.emailSender === undefined || config.email === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'cron-reconciler requires email configuration for reconciliation failure alerting',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  await logAbortedReconciliationRuns(container, correlationId);

  // Keep the configured treasury row in sync with env thresholds (same upsert
  // the monitor and web boot paths perform) before the sweep reads enabled rows.
  await registerConfiguredTreasuries(
    { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
    config,
  );

  const deps = options.reconcileDeps ?? buildReconcileWalletsDependencies(container);
  const reconcileResult = await reconcileWallets(deps, {
    role: 'cron-reconciler',
    credentialId: CRON_CREDENTIAL_ID,
    correlationId,
  });

  const chainOutcomes = chainOutcomesFromFindings(reconcileResult.run.findings);
  const exitKind = classifyReconcilerExit(reconcileResult.run.errorCode, chainOutcomes);
  const exitCode = reconcilerExitCode(exitKind);

  await recordHeartbeat(
    { serviceHeartbeats: container.repositories.serviceHeartbeats, clock: container.clock },
    {
      serviceRole: HEARTBEAT_SERVICE_ROLE,
      operationId: correlationId,
      detail: {
        event: 'run',
        exitKind,
        runId: reconcileResult.run.runId,
        errorCode: reconcileResult.run.errorCode,
        walletsAssessed: reconcileResult.counters.assessed,
        walletsFunded: reconcileResult.counters.funded,
        walletsFailed: reconcileResult.counters.failed,
        // Stringify: heartbeat detail is JSONB; raw bigint cannot be serialized.
        weiTransferred: reconcileResult.counters.weiTransferred.toString(),
        outgoingScanStatus: reconcileResult.outgoingScanStatus,
        chainOutcomes: chainOutcomesForDetail(chainOutcomes),
      },
    },
  );

  logRunOutcome(logger, correlationId, exitKind, reconcileResult);

  return { exitKind, exitCode, reconcileResult };
}

/**
 * Completion-log fields for a finished reconciler run.
 *
 * `weiTransferred` is always a decimal string (including `"0"`) so Pino /
 * `JSON.stringify` never see a raw bigint.
 */
export function buildReconcilerCompletionLogFields(
  correlationId: string,
  exitKind: ReconcilerExitKind,
  result: ReconcileWalletsResult,
): {
  readonly correlationId: string;
  readonly runId: string;
  readonly exitKind: ReconcilerExitKind;
  readonly errorCode: string | undefined;
  readonly walletsAssessed: number;
  readonly walletsFunded: number;
  readonly walletsNoop: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
  readonly weiTransferred: string;
  readonly outgoingScanStatus: ReconcileWalletsResult['outgoingScanStatus'];
  readonly chainOutcomes: ReturnType<typeof chainOutcomesForDetail>;
} {
  return {
    correlationId,
    runId: result.run.runId,
    exitKind,
    errorCode: result.run.errorCode,
    walletsAssessed: result.counters.assessed,
    walletsFunded: result.counters.funded,
    walletsNoop: result.counters.noop,
    walletsBlocked: result.counters.blocked,
    walletsFailed: result.counters.failed,
    weiTransferred: result.counters.weiTransferred.toString(),
    outgoingScanStatus: result.outgoingScanStatus,
    chainOutcomes: chainOutcomesForDetail(chainOutcomesFromFindings(result.run.findings)),
  };
}

export function logRunOutcome(
  logger: Logger,
  correlationId: string,
  exitKind: ReconcilerExitKind,
  result: ReconcileWalletsResult,
): void {
  const base = buildReconcilerCompletionLogFields(correlationId, exitKind, result);

  if (exitKind === 'policy-disabled') {
    logger.info(
      base,
      'Wallet reconciler run skipped by funding policy (FUNDING_ENABLED=false or kill switch); exiting zero',
    );
    return;
  }
  if (exitKind === 'malfunction') {
    logger.error(base, 'Wallet reconciler run finished with run-level malfunction');
    return;
  }
  logger.info(base, 'Wallet reconciler run completed');
}

async function main(): Promise<void> {
  loadDotEnvFile();

  // Signing-capable: TREASURY_PRIVATE_KEY is accepted when FUNDING_ENABLED=true.
  // Email is loaded now so T4.3 failure alerting can use the same process.
  const config = loadConfig({ serviceRole: SERVICE_ROLE });
  const container = buildContainer({ config });
  const correlationId = container.idGenerator.next();
  const startedAt = Date.now();

  container.logger.info({ correlationId }, 'Wallet reconciler run started');

  try {
    // C28: prove each RPC's chain id before this run can dispatch a transfer.
    await proveConfiguredChainIds(container.chainAdapters, container.logger);
    const outcome = await runWalletReconciler(container, correlationId);
    container.logger.info(
      {
        correlationId,
        durationMs: Date.now() - startedAt,
        exitKind: outcome.exitKind,
        exitCode: outcome.exitCode,
      },
      outcome.exitCode === 0 ? 'Wallet reconciler run finished' : 'Wallet reconciler run failed',
    );
    process.exitCode = outcome.exitCode;
  } catch (error) {
    container.logger.error(
      {
        correlationId,
        durationMs: Date.now() - startedAt,
        code: isChainBankError(error) ? error.code : undefined,
        detail: describeErrorChain(error),
      },
      'Wallet reconciler run failed',
    );
    process.exitCode = 1;
  } finally {
    // A cron process must release its pooled connections before exiting, or the
    // shared database slowly accumulates abandoned clients (AGENTS.md §9).
    await container.close();
  }
}

/** True only when this file is the process entry point (not imported by tests). */
function isExecutedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isExecutedAsMain()) {
  main().catch((error: unknown) => {
    const detail = isChainBankError(error) ? error.message : describeUnknownError(error);
    process.stderr.write(
      `${JSON.stringify({ level: 'fatal', service: 'chainbank', role: SERVICE_ROLE, message: 'Cron startup failed', detail })}\n`,
    );
    process.exitCode = 1;
  });
}
