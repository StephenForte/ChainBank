import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import { isEligibleForReconciliation } from '../reconciliation/reconciliation-decisions.js';
import type {
  BalanceReader,
  FundingHealthQuery,
  ManagedWallet,
  ManagedWalletRepository,
  ReconciliationRun,
  ReconciliationRunRepository,
  WalletFundingAttemptRecord,
  WalletLastFundedRecord,
} from '../ports.js';

/**
 * Two wallet-reconciler schedule cycles (every 6 hours → 12h window).
 * Freshness older than this means the cron is effectively dead for consumers.
 */
export const FUNDING_HEALTH_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Overall funding-health status (ForteL2 / CB-01 contract).
 *
 * - `failing` — no **successfully finished** run (`finished_at IS NOT NULL`)
 *   within {@link FUNDING_HEALTH_STALE_AFTER_MS}, or any wallet below policy
 *   with no funding attempt inside that window.
 * - `degraded` — a wallet below policy but within the window (attempt seen),
 *   or the most recent finished run reported `walletsBlocked` /
 *   `walletsFailed` > 0.
 * - `ok` — otherwise.
 *
 * Freshness keys ONLY on `finishedAt` of finished rows. A row with
 * `finished_at IS NULL` (aborted crash) must never satisfy the check — even
 * when `outgoingScanStatus` is `complete` or `startedAt` is recent.
 */
export type FundingHealthStatus = 'ok' | 'degraded' | 'failing';

export type FundingWalletHealthStatus = 'ok' | 'below_policy' | 'blocked' | 'failed';

export type FundingHealthExitKind = 'success' | 'policy-disabled' | 'malfunction';

export interface FundingHealthWallet {
  readonly label: string;
  readonly address: string;
  readonly chainId: number;
  /** Decimal string — never a JS number (wei exceeds MAX_SAFE_INTEGER). */
  readonly balanceWei: string;
  readonly policyMinWei: string;
  readonly lastFundedAt: string | undefined;
  readonly lastFundedWei: string | undefined;
  readonly lastFundedTxHash: string | undefined;
  readonly status: FundingWalletHealthStatus;
}

export interface FundingHealthLastRun {
  readonly runId: string;
  readonly finishedAt: string;
  readonly exitKind: FundingHealthExitKind;
  readonly ageSeconds: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
}

export interface FundingHealthResult {
  readonly status: FundingHealthStatus;
  readonly checkedAt: Date;
  readonly lastRun: FundingHealthLastRun | undefined;
  readonly wallets: readonly FundingHealthWallet[];
}

export interface CheckFundingHealthDependencies {
  readonly reconciliationRuns: ReconciliationRunRepository;
  readonly managedWallets: ManagedWalletRepository;
  readonly fundingHealth: FundingHealthQuery;
  readonly balanceReader: BalanceReader;
  readonly clock: Clock;
}

interface WalletHealthDraft {
  readonly walletId: string;
  readonly view: FundingHealthWallet;
}

/**
 * Builds the funding health signal for GET /health/funding.
 *
 * Read-only: never signs, never mutates policy, never interprets RPC failure
 * as a zero balance (unavailable reads fail the endpoint).
 */
export async function checkFundingHealth(
  dependencies: CheckFundingHealthDependencies,
): Promise<FundingHealthResult> {
  const checkedAt = dependencies.clock.now();
  const windowStart = new Date(checkedAt.getTime() - FUNDING_HEALTH_STALE_AFTER_MS);

  // Authoritative freshness source: finished_at, not started_at / scan status.
  const lastFinished = await dependencies.reconciliationRuns.findLatestFinished();
  const lastRun = toLastRun(lastFinished, checkedAt);

  const wallets = await listEligibleWallets(dependencies.managedWallets);
  const walletIds = wallets.map((wallet) => wallet.id);

  const [fundedRows, attemptRows] = await Promise.all([
    dependencies.fundingHealth.findLatestFundedByWalletIds(walletIds),
    dependencies.fundingHealth.findLatestReconcileAttemptsSince(walletIds, windowStart),
  ]);
  const fundedByWallet = indexByWalletId(fundedRows);
  const attemptByWallet = indexAttemptsByWalletId(attemptRows);

  const drafts: WalletHealthDraft[] = [];
  for (const wallet of wallets) {
    const policyMinWei = wallet.policy?.minimumBalanceWei;
    if (policyMinWei === undefined) {
      continue;
    }

    const reading = await dependencies.balanceReader.readBalance(wallet.addressDisplay);
    if (reading.kind === 'unavailable') {
      throw new ChainBankError(reading.errorCode, reading.reason, {
        publicMessage: 'Funding health could not read a managed wallet balance.',
        context: { managedWalletId: wallet.id },
      });
    }

    const funded = fundedByWallet.get(wallet.id);
    const attempt = attemptByWallet.get(wallet.id);
    const status = classifyWalletStatus({
      balanceWei: reading.balanceWei,
      policyMinWei,
      attempt,
    });

    drafts.push({
      walletId: wallet.id,
      view: {
        label: wallet.role,
        address: wallet.addressDisplay,
        chainId: wallet.chain.chainId,
        balanceWei: reading.balanceWei.toString(),
        policyMinWei: policyMinWei.toString(),
        lastFundedAt: funded?.fundedAt.toISOString(),
        lastFundedWei: funded?.amountWei.toString(),
        lastFundedTxHash: funded?.transactionHash,
        status,
      },
    });
  }

  const status = classifyOverallStatus({
    checkedAt,
    lastFinished,
    lastRun,
    drafts,
    attemptByWallet,
    windowStart,
  });

  return {
    status,
    checkedAt,
    lastRun,
    wallets: drafts.map((draft) => draft.view),
  };
}

/**
 * Pure classifier exported for the freshness-trap regression test.
 *
 * A run without `finishedAt` must never count as fresh, regardless of
 * `startedAt` or `outgoingScanStatus`.
 */
export function isFinishedRunFresh(
  run: Pick<ReconciliationRun, 'finishedAt'> | undefined,
  checkedAt: Date,
  staleAfterMs: number = FUNDING_HEALTH_STALE_AFTER_MS,
): boolean {
  if (run?.finishedAt === undefined) {
    return false;
  }
  return checkedAt.getTime() - run.finishedAt.getTime() <= staleAfterMs;
}

export function classifyOverallStatus(input: {
  readonly checkedAt: Date;
  readonly lastFinished: ReconciliationRun | undefined;
  readonly lastRun: FundingHealthLastRun | undefined;
  readonly drafts: readonly WalletHealthDraft[];
  readonly attemptByWallet: ReadonlyMap<string, WalletFundingAttemptRecord>;
  readonly windowStart: Date;
}): FundingHealthStatus {
  if (!isFinishedRunFresh(input.lastFinished, input.checkedAt)) {
    return 'failing';
  }

  const belowPolicy = input.drafts.filter((draft) => draft.view.status !== 'ok');
  for (const draft of belowPolicy) {
    if (!hasFundingAttemptInWindow(draft.walletId, input)) {
      return 'failing';
    }
  }

  if (belowPolicy.length > 0) {
    return 'degraded';
  }

  if (input.lastRun !== undefined && (input.lastRun.walletsBlocked > 0 || input.lastRun.walletsFailed > 0)) {
    return 'degraded';
  }

  return 'ok';
}

function hasFundingAttemptInWindow(
  walletId: string,
  input: {
    readonly lastFinished: ReconciliationRun | undefined;
    readonly attemptByWallet: ReadonlyMap<string, WalletFundingAttemptRecord>;
    readonly windowStart: Date;
  },
): boolean {
  const attempt = input.attemptByWallet.get(walletId);
  if (attempt !== undefined && attempt.attemptedAt.getTime() >= input.windowStart.getTime()) {
    return true;
  }

  // Sweep-level attempt: a finished non-policy run inside the window assessed
  // every eligible wallet, including reserve-stop paths that create no
  // funding_operations row for subsequent wallets.
  if (
    input.lastFinished?.finishedAt !== undefined &&
    input.lastFinished.finishedAt.getTime() >= input.windowStart.getTime() &&
    input.lastFinished.errorCode === undefined &&
    input.lastFinished.walletsAssessed > 0
  ) {
    return true;
  }

  return false;
}

export function classifyWalletStatus(input: {
  readonly balanceWei: bigint;
  readonly policyMinWei: bigint;
  readonly attempt: WalletFundingAttemptRecord | undefined;
}): FundingWalletHealthStatus {
  if (input.balanceWei >= input.policyMinWei) {
    return 'ok';
  }
  if (input.attempt?.outcome === 'blocked') {
    return 'blocked';
  }
  if (input.attempt?.outcome === 'failed') {
    return 'failed';
  }
  return 'below_policy';
}

export function fundingHealthExitKind(errorCode: string | undefined): FundingHealthExitKind {
  if (errorCode === undefined) {
    return 'success';
  }
  if (errorCode === 'FUNDING_DISABLED') {
    return 'policy-disabled';
  }
  return 'malfunction';
}

function toLastRun(run: ReconciliationRun | undefined, checkedAt: Date): FundingHealthLastRun | undefined {
  if (run?.finishedAt === undefined) {
    return undefined;
  }
  const ageMs = checkedAt.getTime() - run.finishedAt.getTime();
  return {
    runId: run.runId,
    finishedAt: run.finishedAt.toISOString(),
    exitKind: fundingHealthExitKind(run.errorCode),
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    walletsBlocked: run.walletsBlocked,
    walletsFailed: run.walletsFailed,
  };
}

async function listEligibleWallets(
  managedWallets: ManagedWalletRepository,
): Promise<readonly ManagedWallet[]> {
  const eligible: ManagedWallet[] = [];
  let offset = 0;
  const pageSize = 100;
  for (;;) {
    const page = await managedWallets.list(
      { projectId: undefined, environmentId: undefined, enabled: true },
      { limit: pageSize, offset },
    );
    for (const wallet of page.items) {
      if (isEligibleForReconciliation(wallet) && wallet.policy !== undefined) {
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

function indexByWalletId(rows: readonly WalletLastFundedRecord[]): Map<string, WalletLastFundedRecord> {
  return new Map(rows.map((row) => [row.managedWalletId, row]));
}

function indexAttemptsByWalletId(
  rows: readonly WalletFundingAttemptRecord[],
): Map<string, WalletFundingAttemptRecord> {
  return new Map(rows.map((row) => [row.managedWalletId, row]));
}
