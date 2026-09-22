import { findSupportedChainById } from '../../config/supported-chains.js';
import type { ManagedWallet, TreasuryOutgoingTransfer } from '../ports.js';

/**
 * Pure sweep / scan decision helpers for reconciliation (C14).
 * No I/O — unit-tested independently of dispatch and RPC.
 */

export type SweepWalletOutcome =
  | { readonly kind: 'no-op'; readonly reason: 'at-or-above-minimum' }
  | { readonly kind: 'needs-funding' }
  | { readonly kind: 'blocked'; readonly reason: 'reserve-stop' | 'missing-policy' }
  | {
      readonly kind: 'excluded';
      readonly reason:
        'disabled-wallet' | 'disabled-project' | 'disabled-environment' | 'reconciliation-disabled';
    };

/**
 * P4-US1 eligibility: enabled wallet with reconciliationEnabled, under an
 * enabled project and environment.
 */
export function isEligibleForReconciliation(wallet: ManagedWallet): boolean {
  return (
    wallet.enabled && wallet.reconciliationEnabled && wallet.project.enabled && wallet.environment.enabled
  );
}

/**
 * Pre-dispatch assessment for one wallet.
 *
 * When `reserveStopped` is true, wallets that would need funding are recorded
 * as blocked without submitting (C14 stop-and-continue).
 */
export function assessWalletForSweep(input: {
  readonly wallet: ManagedWallet;
  readonly balanceWei: bigint;
  readonly reserveStopped: boolean;
}): SweepWalletOutcome {
  if (!input.wallet.enabled) {
    return { kind: 'excluded', reason: 'disabled-wallet' };
  }
  if (!input.wallet.reconciliationEnabled) {
    return { kind: 'excluded', reason: 'reconciliation-disabled' };
  }
  if (!input.wallet.project.enabled) {
    return { kind: 'excluded', reason: 'disabled-project' };
  }
  if (!input.wallet.environment.enabled) {
    return { kind: 'excluded', reason: 'disabled-environment' };
  }
  if (input.wallet.policy === undefined) {
    return { kind: 'blocked', reason: 'missing-policy' };
  }

  // At-or-above minimum is a no-op even when below target (P4-US1 / C2).
  if (input.balanceWei >= input.wallet.policy.minimumBalanceWei) {
    return { kind: 'no-op', reason: 'at-or-above-minimum' };
  }

  if (input.reserveStopped) {
    return { kind: 'blocked', reason: 'reserve-stop' };
  }

  return { kind: 'needs-funding' };
}

export type OutgoingClassification = { readonly kind: 'explained' } | { readonly kind: 'unexplained' };

/**
 * An on-chain treasury transfer with no matching funding_transactions hash is
 * a critical finding — never silently adopted into history (C14 / T1.9).
 */
export function classifyOutgoingAgainstRecords(
  transfer: TreasuryOutgoingTransfer,
  recordedHashesLowercase: ReadonlySet<string>,
): OutgoingClassification {
  const hash = transfer.transactionHash.toLowerCase();
  if (recordedHashesLowercase.has(hash)) {
    return { kind: 'explained' };
  }
  return { kind: 'unexplained' };
}

/**
 * Positive-evidence match: the mined transfer at the recorded nonce is ours
 * only when destination and amount both match the submission_unknown row.
 */
export function isMatchingSubmissionTransfer(input: {
  readonly transfer: TreasuryOutgoingTransfer;
  readonly walletAddress: string;
  readonly amountWei: bigint;
}): boolean {
  if (input.transfer.toAddress === undefined) {
    return false;
  }
  if (input.transfer.toAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return false;
  }
  return input.transfer.valueWei === input.amountWei;
}

export interface SweepCounters {
  readonly assessed: number;
  readonly funded: number;
  readonly noop: number;
  readonly blocked: number;
  readonly failed: number;
  readonly weiTransferred: bigint;
}

export function emptySweepCounters(): SweepCounters {
  return {
    assessed: 0,
    funded: 0,
    noop: 0,
    blocked: 0,
    failed: 0,
    weiTransferred: 0n,
  };
}

export function addSweepOutcome(
  counters: SweepCounters,
  outcome: 'funded' | 'noop' | 'blocked' | 'failed',
  transferredWei: bigint = 0n,
): SweepCounters {
  return {
    assessed: counters.assessed + 1,
    funded: counters.funded + (outcome === 'funded' ? 1 : 0),
    noop: counters.noop + (outcome === 'noop' ? 1 : 0),
    blocked: counters.blocked + (outcome === 'blocked' ? 1 : 0),
    failed: counters.failed + (outcome === 'failed' ? 1 : 0),
    weiTransferred: counters.weiTransferred + transferredWei,
  };
}

/** Deterministic per-run, per-wallet idempotency key (C14). */
export function reconciliationIdempotencyKey(runId: string, walletId: string): string {
  return `reconcile:${runId}:${walletId}`;
}

/**
 * Sepolia default block time (`ethereum-sepolia.blockTimeMs`).
 * Prefer the active chain descriptor's `blockTimeMs` at the hunt site; this
 * named re-export remains for one release so existing tests keep compiling.
 */
export const RECONCILE_BLOCK_TIME_MS = sepoliaDefaultBlockTimeMs();

function sepoliaDefaultBlockTimeMs(): number {
  const sepolia = findSupportedChainById(11_155_111);
  if (sepolia === undefined) {
    throw new Error('ethereum-sepolia is missing from SUPPORTED_CHAINS');
  }
  return sepolia.blockTimeMs;
}

/** Extra blocks beyond age estimate so a slightly slow block does not miss a match. */
export const NONCE_SEARCH_BLOCK_MARGIN = 256n;

export type OutgoingScanWindowPlan =
  | {
      readonly kind: 'empty';
      readonly tip: bigint;
      readonly lastScannedBlock: bigint;
    }
  | {
      readonly kind: 'scan';
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
      readonly tip: bigint;
      readonly lastScannedBlock: bigint | undefined;
      /**
       * True when this run cannot reach the tip under the per-run cap
       * (`toBlock < tip`). Standing condition — not a one-shot skip flag.
       */
      readonly isCoverageBehind: boolean;
      /** Inclusive end block to persist on success; never past what this plan scans. */
      readonly advanceMarkerTo: bigint;
      /** Blocks still outstanding after this plan (`tip - toBlock`). */
      readonly blocksRemaining: bigint;
    };

/**
 * Plans the next crash-orphan outgoing window (C14 / TX.9).
 *
 * `maxBlocksPerRun` is a per-run cap (RECONCILE_OUTGOING_LOOKBACK_BLOCKS), not a
 * fixed "always scan this much" lookback. First run / no marker falls back to a
 * tip-relative capped window. With a marker, windows are always
 * forward-contiguous from `lastScannedBlock + 1` so no range is abandoned.
 */
export function planOutgoingScanWindow(input: {
  readonly tip: bigint;
  readonly lastScannedBlock: bigint | undefined;
  readonly maxBlocksPerRun: bigint;
}): OutgoingScanWindowPlan {
  if (input.tip < 0n) {
    throw new Error('tip must be non-negative');
  }
  if (input.maxBlocksPerRun <= 0n) {
    throw new Error('maxBlocksPerRun must be positive');
  }

  const { tip, lastScannedBlock, maxBlocksPerRun } = input;

  // Includes tip < marker (reorg / tip regression): idle until the chain catches
  // up. Stated limitation in C14 TX.9 — no rescan of reorged-out marker blocks.
  if (lastScannedBlock !== undefined && lastScannedBlock >= tip) {
    return { kind: 'empty', tip, lastScannedBlock };
  }

  if (lastScannedBlock === undefined) {
    const fromBlock = tip > maxBlocksPerRun ? tip - maxBlocksPerRun : 0n;
    return {
      kind: 'scan',
      fromBlock,
      toBlock: tip,
      tip,
      lastScannedBlock: undefined,
      isCoverageBehind: false,
      advanceMarkerTo: tip,
      blocksRemaining: 0n,
    };
  }

  // Forward-contiguous: never skip past an unscanned block. Cap bounds how far
  // this run advances; backlog drains over successive runs.
  const fromBlock = lastScannedBlock + 1n;
  const cappedTo = lastScannedBlock + maxBlocksPerRun;
  const toBlock = cappedTo < tip ? cappedTo : tip;
  const blocksRemaining = tip - toBlock;
  return {
    kind: 'scan',
    fromBlock,
    toBlock,
    tip,
    lastScannedBlock,
    isCoverageBehind: blocksRemaining > 0n,
    advanceMarkerTo: toBlock,
    blocksRemaining,
  };
}

/**
 * TX.14 nonce gate: every outgoing treasury transaction consumes exactly one
 * nonce. Equality of the confirmed count at the planned tip with the count
 * recorded when the watermark last advanced proves the planned window contains
 * zero outgoing transactions — a skip on proven equality is a complete scan of
 * that window. A null/undefined stored nonce never skips here. TX.34 proves
 * that case from the window edges instead; it does not relax this predicate.
 */
export function shouldSkipOutgoingBodyScan(input: {
  readonly storedNonce: number | undefined;
  readonly tipNonce: number;
}): boolean {
  return input.storedNonce !== undefined && input.storedNonce === input.tipNonce;
}

export type NullNonceEdgeGateDecision =
  | { readonly kind: 'body-scan' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'skip'; readonly nonce: number };

/**
 * TX.34 null-nonce edge gate. Only for a treasury that has no stored nonce.
 *
 * Equal transaction counts at `fromBlock - 1` and at `toBlock` prove the
 * address sent nothing in `[fromBlock, toBlock]`: every send consumes one
 * nonce, so a flat count is an empty window. That is a complete scan, same
 * as a TX.14 skip. Counts that differ are not interpreted — the caller
 * body-scans. An unavailable edge is incomplete, never a clean skip and
 * never a zero. `fromBlock === 0` has no predecessor block, so the edge
 * read is impossible and the caller must body-scan.
 */
export function decideNullNonceEdgeGate(input: {
  readonly fromBlock: bigint;
  readonly countBeforeWindow: number | undefined;
  readonly countAtToBlock: number | undefined;
  readonly edgeReadUnavailable: boolean;
}): NullNonceEdgeGateDecision {
  if (input.fromBlock <= 0n) {
    return { kind: 'body-scan' };
  }
  if (input.edgeReadUnavailable) {
    return { kind: 'incomplete' };
  }
  if (!isNonNegativeInteger(input.countBeforeWindow) || !isNonNegativeInteger(input.countAtToBlock)) {
    return { kind: 'incomplete' };
  }
  if (input.countBeforeWindow === input.countAtToBlock) {
    return { kind: 'skip', nonce: input.countAtToBlock };
  }
  return { kind: 'body-scan' };
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

/**
 * TX.34. A completed scan with nothing to report may persist its watermark
 * before the next treasury. Any finding — unexplained transfer,
 * coverage-behind, incomplete — stays on the post-escalation write, because
 * advancing the marker and then dying before the alert would let the next
 * run skip the only evidence.
 */
export function shouldPersistOutgoingWatermarkImmediately(input: {
  readonly scanStatus: 'complete' | 'incomplete';
  readonly findingCount: number;
  readonly unexplainedCount: number;
  readonly hasPendingAdvance: boolean;
}): boolean {
  return (
    input.hasPendingAdvance &&
    input.scanStatus === 'complete' &&
    input.findingCount === 0 &&
    input.unexplainedCount === 0
  );
}

/**
 * Bound `findOutgoingByNonce` by the `submission_unknown` row's age rather than
 * blindly inheriting the incremental crash-orphan window. Cap at the per-run
 * maximum. Absence within the searched window must leave the row pending.
 */
export function nonceSearchLookbackBlocks(input: {
  readonly createdAt: Date;
  readonly now: Date;
  readonly maxBlocks: bigint;
  readonly blockTimeMs?: number;
}): bigint {
  if (input.maxBlocks <= 0n) {
    throw new Error('maxBlocks must be positive');
  }
  const blockTimeMs = input.blockTimeMs ?? RECONCILE_BLOCK_TIME_MS;
  if (!Number.isFinite(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error('blockTimeMs must be a positive finite number');
  }

  const ageMs = Math.max(0, input.now.getTime() - input.createdAt.getTime());
  const ageBlocks = BigInt(Math.ceil(ageMs / blockTimeMs));
  const needed = ageBlocks + NONCE_SEARCH_BLOCK_MARGIN;
  return needed > input.maxBlocks ? input.maxBlocks : needed;
}
