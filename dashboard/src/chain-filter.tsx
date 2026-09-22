import { useState } from 'react';
import type { AlertResource, ReconciliationRunResource, TreasuryResource } from './api';
import {
  chainIdForAlert,
  chainIdForFinding,
  findingAlertEntityId,
  isCriticalFindingAcknowledged,
  isUnavailableChainOutcome,
  toFindingViews,
  type LoadState,
} from './dashboard-shared';

/**
 * Browser-local chain selection. Same localStorage shape as the C32 collapse
 * keys: a single string, read once, written when the operator picks a segment.
 * The filter is a view. Changing it does not fetch.
 */
export const CHAIN_FILTER_STORAGE_KEY = 'chainbank.chainFilter';

export const ALL_CHAINS = 'ALL' as const;

export type ChainFilterSelection = typeof ALL_CHAINS | number;

/** `'ALL'` matches every row. A one-element list is the selected chain. */
export type VisibleChainIds = typeof ALL_CHAINS | readonly number[];

export type ChainSegment = {
  readonly chainId: number;
  readonly displayName: string;
};

export type ChainSegmentAttention = {
  readonly chainId: number;
  readonly criticalCount: number;
  readonly isDark: boolean;
};

/**
 * One segment per distinct treasury chain, labelled with `displayName`,
 * ordered by descending chainId so Ethereum Sepolia (11155111) precedes
 * Base Sepolia (84532). A newly registered chain slots into that order.
 */
export function deriveChainSegments(
  treasuries: readonly { readonly chain: { readonly chainId: number; readonly displayName: string } }[],
): readonly ChainSegment[] {
  const byId = new Map<number, string>();
  for (const treasury of treasuries) {
    if (!byId.has(treasury.chain.chainId)) {
      byId.set(treasury.chain.chainId, treasury.chain.displayName);
    }
  }
  return [...byId.entries()]
    .map(([chainId, displayName]) => ({ chainId, displayName }))
    .sort((left, right) => right.chainId - left.chainId);
}

/**
 * Shared predicate. `'ALL'` matches every resource. A resource with no chain
 * id matches every selection, so a finding the dashboard cannot place, and
 * any chain-agnostic row, stays on screen.
 */
export function matchesChainFilter(
  resource: {
    readonly chain?: { readonly chainId: number };
    readonly chainId?: number | undefined;
  },
  visibleChainIds: VisibleChainIds,
): boolean {
  if (visibleChainIds === ALL_CHAINS) {
    return true;
  }
  const chainId = resource.chain?.chainId ?? resource.chainId;
  if (chainId === undefined) {
    return true;
  }
  return visibleChainIds.includes(chainId);
}

function textNamesChain(text: string, chain: ChainSegment): boolean {
  if (chain.displayName !== '' && text.includes(chain.displayName)) {
    return true;
  }
  const id = String(chain.chainId);
  return new RegExp(`(?:^|\\D)${id}(?:\\D|$)`).test(text);
}

/**
 * A readiness row that names no loaded chain stays. A row that names one or
 * more chains stays when any of those chains is selected.
 */
export function readinessRowMatches(
  text: string,
  chains: readonly ChainSegment[],
  visibleChainIds: VisibleChainIds,
): boolean {
  const named = chains.filter((chain) => textNamesChain(text, chain));
  if (named.length === 0) {
    return matchesChainFilter({ chainId: undefined }, visibleChainIds);
  }
  return named.some((chain) => matchesChainFilter(chain, visibleChainIds));
}

/**
 * Unacknowledged criticals and dark chains, per segment. Criticals are
 * counted once per finding key so an open alert and the same run finding
 * do not add. A chain that is not selected still gets its badge (C20, C30).
 */
export function attentionByChain(input: {
  readonly segments: readonly ChainSegment[];
  readonly treasuries: readonly TreasuryResource[];
  readonly runs: readonly ReconciliationRunResource[];
  readonly openFindingAlerts: readonly AlertResource[];
  readonly acknowledgedFindingAlerts: readonly AlertResource[];
  readonly findingAlertsState: LoadState;
  readonly openFindingAlertsComplete: boolean;
}): readonly ChainSegmentAttention[] {
  const criticalCounts = new Map<number, number>();
  const seen = new Set<string>();
  const dark = new Set<number>();

  const addCritical = (chainId: number, key: string): void => {
    const dedupe = `${String(chainId)}:${key.toLowerCase()}`;
    if (seen.has(dedupe)) {
      return;
    }
    seen.add(dedupe);
    criticalCounts.set(chainId, (criticalCounts.get(chainId) ?? 0) + 1);
  };

  for (const alert of input.openFindingAlerts) {
    const chainId = chainIdForAlert(alert, input.treasuries);
    if (chainId === undefined) {
      continue;
    }
    addCritical(chainId, alert.entityId);
  }

  for (const finding of toFindingViews(input.runs)) {
    if (isUnavailableChainOutcome(finding) && finding.chainId !== undefined) {
      dark.add(finding.chainId);
    }
    if (finding.severity !== 'critical') {
      continue;
    }
    const acknowledged = isCriticalFindingAcknowledged(
      finding,
      input.findingAlertsState,
      input.openFindingAlerts,
      input.acknowledgedFindingAlerts,
      input.openFindingAlertsComplete,
    );
    if (acknowledged) {
      continue;
    }
    const chainId = chainIdForFinding(finding, input.treasuries);
    if (chainId === undefined) {
      continue;
    }
    const entityId = findingAlertEntityId(finding);
    const key =
      entityId ??
      `${finding.runId}:${finding.kind}:${finding.treasuryId ?? ''}:${String(finding.chainId ?? '')}`;
    addCritical(chainId, key);
  }

  return input.segments.map((segment) => ({
    chainId: segment.chainId,
    criticalCount: criticalCounts.get(segment.chainId) ?? 0,
    isDark: dark.has(segment.chainId),
  }));
}

export type ChainFilterControlProps = {
  readonly segments: readonly ChainSegment[];
  readonly selection: ChainFilterSelection;
  readonly attention: readonly ChainSegmentAttention[];
  readonly onSelect: (next: ChainFilterSelection) => void;
};

export function ChainFilterControl({ segments, selection, attention, onSelect }: ChainFilterControlProps) {
  return (
    <div className="chain-filter" role="group" aria-label="Chain">
      <button
        type="button"
        aria-pressed={selection === ALL_CHAINS}
        onClick={() => {
          onSelect(ALL_CHAINS);
        }}
      >
        ALL
      </button>
      {segments.map((segment) => {
        const mark = attention.find((item) => item.chainId === segment.chainId);
        return (
          <button
            key={segment.chainId}
            type="button"
            aria-pressed={selection === segment.chainId}
            onClick={() => {
              onSelect(segment.chainId);
            }}
          >
            {segment.displayName}
            {mark !== undefined && mark.criticalCount > 0 ? (
              <span className="chain-filter-badge">{String(mark.criticalCount)}</span>
            ) : null}
            {mark?.isDark === true ? (
              <span className="chain-filter-badge chain-filter-badge-dark">
                <span className="visually-hidden">unavailable</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function readStoredChainFilter(): ChainFilterSelection {
  try {
    const raw = localStorage.getItem(CHAIN_FILTER_STORAGE_KEY);
    if (raw === null || raw.trim() === '' || raw === ALL_CHAINS) {
      return ALL_CHAINS;
    }
    if (!/^[0-9]+$/.test(raw)) {
      return ALL_CHAINS;
    }
    const chainId = Number(raw);
    if (!Number.isSafeInteger(chainId)) {
      return ALL_CHAINS;
    }
    return chainId;
  } catch {
    return ALL_CHAINS;
  }
}

function writeStoredChainFilter(selection: ChainFilterSelection): void {
  try {
    localStorage.setItem(CHAIN_FILTER_STORAGE_KEY, selection === ALL_CHAINS ? ALL_CHAINS : String(selection));
  } catch {
    // Private mode and disabled storage leave the choice for this mount only.
  }
}

function resolveSelection(
  stored: ChainFilterSelection,
  segments: readonly ChainSegment[],
  isTreasuryListSettled: boolean,
): ChainFilterSelection {
  if (stored === ALL_CHAINS) {
    return ALL_CHAINS;
  }
  if (segments.some((segment) => segment.chainId === stored)) {
    return stored;
  }
  // Treasuries have not loaded yet. Keep the stored id so a slow response
  // does not flash ALL and is not treated as an unknown chain.
  if (!isTreasuryListSettled) {
    return stored;
  }
  return ALL_CHAINS;
}

/**
 * Owns derivation, persistence, and the visible set. Pages filter their own
 * rows with `matchesChainFilter` and the `visibleChainIds` this returns.
 */
export function useChainFilter(
  treasuries: readonly { readonly chain: { readonly chainId: number; readonly displayName: string } }[],
  isTreasuryListSettled: boolean,
): {
  readonly segments: readonly ChainSegment[];
  readonly selection: ChainFilterSelection;
  readonly visibleChainIds: VisibleChainIds;
  readonly selectChain: (next: ChainFilterSelection) => void;
} {
  const [stored, setStored] = useState<ChainFilterSelection>(readStoredChainFilter);
  const segments = deriveChainSegments(treasuries);
  const selection = resolveSelection(stored, segments, isTreasuryListSettled);
  const visibleChainIds: VisibleChainIds = selection === ALL_CHAINS ? ALL_CHAINS : [selection];

  const selectChain = (next: ChainFilterSelection): void => {
    setStored(next);
    writeStoredChainFilter(next);
  };

  return { segments, selection, visibleChainIds, selectChain };
}
