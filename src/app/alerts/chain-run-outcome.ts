import { isChainBankError, type ChainBankError } from '../../domain/errors.js';
import type { ReconciliationFinding } from '../ports.js';

/**
 * Per-chain result of one cron run (C29).
 *
 * `processed` — the chain was reachable and no item failed.
 * `processed-with-failures` — the chain was reachable and at least one item failed.
 * `unavailable` — the chain was not processed because its RPC did not answer.
 */
export type ChainProcessingStatus = 'processed' | 'processed-with-failures' | 'unavailable';

export interface ChainRunOutcome {
  /** EVM chain id, not the `chains` table uuid. */
  readonly chainId: number;
  readonly status: ChainProcessingStatus;
  readonly errorCode: string | undefined;
  readonly reason: string | undefined;
}

/**
 * RPC failures that belong to one chain. Anything else (database, signer
 * missing, configuration) still fails the whole run.
 */
const ISOLATED_CHAIN_ERROR_CODES: ReadonlySet<string> = new Set(['RPC_UNAVAILABLE', 'CHAIN_ID_MISMATCH']);

export function isIsolatedChainRpcFailure(error: unknown): error is ChainBankError {
  return isChainBankError(error) && ISOLATED_CHAIN_ERROR_CODES.has(error.code);
}

export function toChainOutcomeFinding(outcome: ChainRunOutcome): ReconciliationFinding {
  return {
    kind: 'chain_outcome',
    severity: 'warning',
    chainId: outcome.chainId,
    status: outcome.status,
    errorCode: outcome.errorCode,
    reason: outcome.reason,
  };
}

export function chainOutcomesFromFindings(
  findings: readonly ReconciliationFinding[],
): readonly ChainRunOutcome[] {
  const outcomes: ChainRunOutcome[] = [];
  for (const finding of findings) {
    if (finding.kind !== 'chain_outcome') {
      continue;
    }
    outcomes.push({
      chainId: finding.chainId,
      status: finding.status,
      errorCode: finding.errorCode,
      reason: finding.reason,
    });
  }
  return outcomes;
}

/**
 * True when this run both processed a chain and could not process another.
 * A single configured chain does not match, so the live one-chain deployment
 * keeps its existing exit and C15 classification.
 */
export function isPartialChainOutage(outcomes: readonly ChainRunOutcome[]): boolean {
  let unavailable = false;
  let processed = false;
  for (const outcome of outcomes) {
    if (outcome.status === 'unavailable') {
      unavailable = true;
    } else {
      processed = true;
    }
  }
  return unavailable && processed;
}

/**
 * Process exit for a partial chain outage (C29). This is the only place that
 * chooses it.
 *
 * `malfunction` exits 1. Render pages on that exit. A `success` return would
 * leave a dark chain green — the CB-04 shape — and would depend on the alert
 * email path that TX.15 showed can store a finding and still send nothing.
 *
 * An operator who wants a quiet flaky testnet RPC changes this return to
 * `success`. C15 still classifies the run as failure, so an open alert is
 * not cleared and the finding stays on the run row.
 */
export function exitKindForPartialChainOutage(): 'success' | 'malfunction' {
  return 'malfunction';
}

export function deriveChainProcessingStatus(input: {
  readonly rpcBlockedFunding: boolean;
  readonly anyWalletObserved: boolean;
  readonly anyItemFailure: boolean;
  readonly anyScanReachedChain: boolean;
  readonly anyScanRpcUnavailable: boolean;
}): ChainProcessingStatus {
  if (input.rpcBlockedFunding && !input.anyWalletObserved) {
    return 'unavailable';
  }
  const reached = input.anyWalletObserved || input.anyScanReachedChain;
  if (!reached && input.anyScanRpcUnavailable) {
    return 'unavailable';
  }
  if (input.anyItemFailure || input.anyScanRpcUnavailable) {
    return 'processed-with-failures';
  }
  return 'processed';
}

/** JSON-safe heartbeat / log shape. `errorCode` is null when the chain was processed. */
export function chainOutcomesForDetail(outcomes: readonly ChainRunOutcome[]): readonly {
  readonly chainId: number;
  readonly status: ChainProcessingStatus;
  readonly errorCode: string | null;
}[] {
  return outcomes.map((outcome) => ({
    chainId: outcome.chainId,
    status: outcome.status,
    errorCode: outcome.errorCode ?? null,
  }));
}
