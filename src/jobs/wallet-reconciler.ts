import { pathToFileURL } from 'node:url';
import { isNull } from 'drizzle-orm';
import { registerConfiguredTreasury } from '../app/bootstrap/register-configured-treasury.js';
import { recordHeartbeat } from '../app/health/record-heartbeat.js';
import {
  reconcileWallets,
  type ReconcileWalletsDependencies,
  type ReconcileWalletsResult,
} from '../app/reconciliation/reconcile-wallets.js';
import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer, type Container } from '../container.js';
import { ChainBankError, describeUnknownError, isChainBankError } from '../domain/errors.js';
import { reconciliationRuns } from '../infrastructure/db/schema.js';
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
 * Exit classification for a finished reconciliation run (T4.2).
 *
 * - `success` / `policy-disabled` → process exit 0 (Render must not page)
 * - `malfunction` → process exit 1 (DB/RPC/signer/unhandled run-level failure)
 *
 * `FUNDING_DISABLED` (including kill switch) is policy, not malfunction: a kill
 * switch left on for a week must not produce twenty-eight failed-run pages.
 */
export type ReconcilerExitKind = 'success' | 'policy-disabled' | 'malfunction';

export function classifyReconcilerExit(errorCode: string | undefined): ReconcilerExitKind {
  if (errorCode === undefined) {
    return 'success';
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
    balanceReader: container.balanceReader,
    auditEvents: container.repositories.auditEvents,
    alerts: container.repositories.alerts,
    emailSender: container.emailSender,
    operations: container.repositories.fundingOperations,
    transactions: container.repositories.fundingTransactions,
    reconciliationRuns: container.repositories.reconciliationRuns,
    reconciliationFunding: container.repositories.reconciliationFunding,
    outgoingScanner: container.treasuryOutgoingScanner,
    lock: container.fundingDispatchLock,
    receiptTracker: container.transactionReceiptTracker,
    signer: container.treasurySigner,
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

/**
 * Surfaces rows left with `finished_at IS NULL` from a prior crash.
 *
 * Unfinished rows must never be read as a clean report (PR #40 / C14). TX.9
 * changed the insert default to `'not-run'`. `finished_at IS NULL` is
 * authoritative for aborted rows. Finished pre-`0005` rows may still read
 * `'complete'` from the old default even when no scan ran (e.g. historical
 * FUNDING_DISABLED exits) — migration `0005` deliberately does not backfill.
 */
export async function logAbortedReconciliationRuns(
  container: Container,
  correlationId: string,
): Promise<number> {
  const rows = await container.database.db
    .select({
      id: reconciliationRuns.id,
      runId: reconciliationRuns.runId,
      startedAt: reconciliationRuns.startedAt,
      outgoingScanStatus: reconciliationRuns.outgoingScanStatus,
      errorCode: reconciliationRuns.errorCode,
    })
    .from(reconciliationRuns)
    .where(isNull(reconciliationRuns.finishedAt));

  if (rows.length === 0) {
    return 0;
  }

  container.logger.warn(
    {
      correlationId,
      abortedCount: rows.length,
      abortedRuns: rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        startedAt: row.startedAt.toISOString(),
        outgoingScanStatus: row.outgoingScanStatus,
        errorCode: row.errorCode,
        note: 'finished_at IS NULL — treat as aborted, not a clean complete scan',
      })),
    },
    'Prior reconciliation runs aborted before finish',
  );
  return rows.length;
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
  await registerConfiguredTreasury(
    { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
    {
      chain: {
        slug: config.chain.slug,
        chainId: config.chain.chainId,
        displayName: config.chain.displayName,
        nativeSymbol: config.chain.nativeSymbol,
        explorerBaseUrl: config.chain.explorerBaseUrl,
      },
      treasuryAddress: config.treasury.address.toLowerCase(),
      treasuryAddressDisplay: config.treasury.address,
      thresholds: {
        warningBalanceWei: config.treasury.warningBalanceWei,
        criticalBalanceWei: config.treasury.criticalBalanceWei,
        recoveryBalanceWei: config.treasury.recoveryBalanceWei,
        minimumReserveWei: config.treasury.minimumReserveWei,
      },
    },
  );

  const deps = options.reconcileDeps ?? buildReconcileWalletsDependencies(container);
  const reconcileResult = await reconcileWallets(deps, {
    role: 'cron-reconciler',
    credentialId: CRON_CREDENTIAL_ID,
    correlationId,
  });

  const exitKind = classifyReconcilerExit(reconcileResult.run.errorCode);
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
        outgoingScanStatus: reconcileResult.outgoingScanStatus,
      },
    },
  );

  logRunOutcome(logger, correlationId, exitKind, reconcileResult);

  return { exitKind, exitCode, reconcileResult };
}

function logRunOutcome(
  logger: Logger,
  correlationId: string,
  exitKind: ReconcilerExitKind,
  result: ReconcileWalletsResult,
): void {
  const base = {
    correlationId,
    runId: result.run.runId,
    exitKind,
    errorCode: result.run.errorCode,
    walletsAssessed: result.counters.assessed,
    walletsFunded: result.counters.funded,
    walletsNoop: result.counters.noop,
    walletsBlocked: result.counters.blocked,
    walletsFailed: result.counters.failed,
    outgoingScanStatus: result.outgoingScanStatus,
  };

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
        detail: describeUnknownError(error),
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
