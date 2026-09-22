import type { FundingTransactionResource, TreasuryResource } from '../../api';
import { matchesChainFilter, type VisibleChainIds } from '../../chain-filter';
import {
  CollapsibleSection,
  COLLAPSE_STORAGE_KEYS,
  treasuryDetailStorageKey,
} from '../../collapsible-section';
import {
  formatTimestamp,
  isTreasuryReplenish,
  listSpansMultipleChains,
  shortAddress,
  statusClass,
  treasuryCardToneClass,
  type LoadState,
} from '../../dashboard-shared';
import { DataTable } from '../../primitives';
import { useHasPermission } from '../../session/permissions';

export type TreasuriesPanelProps = {
  readonly loadTreasuries: () => Promise<void>;
  readonly loadTreasuryFundingHistory: () => Promise<void>;
  readonly treasuriesState: LoadState;
  readonly treasuriesError: string | undefined;
  readonly treasuries: readonly TreasuryResource[];
  readonly treasuryBusyId: string | undefined;
  readonly onCheck: (treasuryId: string) => Promise<void>;
  readonly treasuryFundingHistoryState: LoadState;
  readonly treasuryFundingHistoryError: string | undefined;
  readonly treasuryFundingHistory: readonly FundingTransactionResource[];
  /** Absent means every chain, so existing callers keep today's rows. */
  readonly visibleChainIds?: VisibleChainIds;
  /** Compact is the overview card: collapsed detail, no auto-funding section. */
  readonly presentation?: 'full' | 'compact';
};

function treasuryLabel(treasury: TreasuryResource): string {
  return treasury.displayKind ?? (treasury.kind === 'operational' ? 'Private' : 'Public');
}

function ReplenishRows({ rows }: { readonly rows: readonly FundingTransactionResource[] }) {
  if (rows.length === 0) {
    return <p className="muted">No Public → Private auto-funding yet.</p>;
  }
  const chainsMixed = listSpansMultipleChains(rows);
  return (
    <DataTable caption="Public to Private auto-funding">
      <thead>
        <tr>
          <th>When</th>
          <th>Destination</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Transaction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{formatTimestamp(row.confirmedAt ?? row.createdAt)}</td>
            <td className="mono">
              {row.destinationTreasury === undefined || row.destinationTreasury === null
                ? 'Private'
                : `Private ${shortAddress(row.destinationTreasury.address)}`}
            </td>
            <td className="mono">
              {row.amountEther} {row.chain.nativeSymbol}
              {chainsMixed ? ` · ${row.chain.displayName}` : ''}
            </td>
            <td>
              <span className={statusClass(row.status)}>{row.status}</span>
            </td>
            <td className="mono">
              {row.explorerUrl === null ? (
                '—'
              ) : (
                <a href={row.explorerUrl} target="_blank" rel="noreferrer">
                  {shortAddress(row.transactionHash ?? '')}
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export function TreasuriesPanel({
  loadTreasuries,
  loadTreasuryFundingHistory,
  treasuriesState,
  treasuriesError,
  treasuries,
  treasuryBusyId,
  onCheck,
  treasuryFundingHistoryState,
  treasuryFundingHistoryError,
  treasuryFundingHistory,
  visibleChainIds = 'ALL',
  presentation = 'full',
}: TreasuriesPanelProps) {
  const canCheckTreasury = useHasPermission('treasury:check');
  const visibleTreasuries = treasuries.filter((treasury) => matchesChainFilter(treasury, visibleChainIds));
  const replenishAll = treasuryFundingHistory.filter(isTreasuryReplenish);
  const replenishRows = replenishAll.filter((row) => matchesChainFilter(row, visibleChainIds));
  const compact = presentation === 'compact';

  return (
    <section className={compact ? 'treasury-compact' : 'panel'}>
      {compact ? null : (
        <div className="panel-head">
          <h2 className="section-title">Treasuries</h2>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void loadTreasuries();
              void loadTreasuryFundingHistory();
            }}
          >
            Reload
          </button>
        </div>
      )}
      {treasuriesState === 'loading' ? <p className="muted">Loading…</p> : null}
      {treasuriesState === 'error' ? <p className="error-inline">{treasuriesError}</p> : null}
      {treasuriesState === 'empty' ? <p className="muted">No enabled treasuries returned.</p> : null}
      {treasuriesState === 'ready' && treasuries.length > 0 && visibleTreasuries.length === 0 ? (
        <p className="muted">No treasuries on this chain.</p>
      ) : null}
      {treasuriesState === 'ready' && visibleTreasuries.length > 0 ? (
        <div className="treasury-list">
          {visibleTreasuries.map((treasury) => {
            const isOperational = treasury.kind === 'operational';
            return (
              <article key={treasury.id} className={treasuryCardToneClass(treasury.status)}>
                <div className="treasury-head">
                  <span className={statusClass(treasury.status)}>{treasury.status}</span>
                  <h3>
                    {treasuryLabel(treasury)} · {treasury.chain.displayName}
                  </h3>
                </div>
                <p className="mono">
                  <a href={treasury.explorerUrl} target="_blank" rel="noreferrer">
                    {treasury.address}
                  </a>
                </p>
                <dl className="facts treasury-facts-primary">
                  <div>
                    <dt>Balance</dt>
                    <dd className="mono">
                      {treasury.balance.ether === null
                        ? 'unavailable'
                        : `${treasury.balance.ether} ${treasury.chain.nativeSymbol}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Spendable</dt>
                    <dd className="mono">
                      {treasury.spendable.ether === null
                        ? '—'
                        : `${treasury.spendable.ether} ${treasury.chain.nativeSymbol}`}
                    </dd>
                  </div>
                </dl>
                {canCheckTreasury ? (
                  <button
                    type="button"
                    disabled={treasuryBusyId === treasury.id}
                    onClick={() => void onCheck(treasury.id)}
                  >
                    Check now
                  </button>
                ) : null}
                <CollapsibleSection
                  title="Thresholds and last checked"
                  storageKey={treasuryDetailStorageKey(treasury.id)}
                >
                  {isOperational ? (
                    <p className="muted">
                      Auto-filled from Public when policy says so. Managed wallets spend from here.
                    </p>
                  ) : (
                    <p className="muted">
                      Refill this address from a faucet or exchange. Auto-funding of Private starts from here.
                    </p>
                  )}
                  <dl className="facts">
                    <div>
                      <dt>Last checked</dt>
                      <dd>
                        {treasury.lastCheckedAt === null
                          ? 'never'
                          : new Date(treasury.lastCheckedAt).toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Thresholds</dt>
                      <dd className="mono">
                        warn {treasury.thresholds.warningEther} · crit {treasury.thresholds.criticalEther} ·
                        reserve {treasury.thresholds.minimumReserveEther}
                      </dd>
                    </div>
                  </dl>
                  {treasury.lastCheckErrorCode !== null ? (
                    <p className="error-inline">Last error: {treasury.lastCheckErrorCode}</p>
                  ) : null}
                </CollapsibleSection>
              </article>
            );
          })}
        </div>
      ) : null}

      {compact ? null : (
        <CollapsibleSection
          title="Auto-funding history"
          storageKey={COLLAPSE_STORAGE_KEYS.treasuryAutoFunding}
        >
          <div className="history-mini">
            <p className="muted">
              Public → Private replenish only. Wallet top-ups stay in Funding history. Deposits into Public
              are expected human refills and are not listed here.
            </p>
            {treasuryFundingHistoryState === 'loading' ? <p className="muted">Loading…</p> : null}
            {treasuryFundingHistoryState === 'error' ? (
              <p className="error-inline">{treasuryFundingHistoryError}</p>
            ) : null}
            {treasuryFundingHistoryState === 'empty' ||
            (treasuryFundingHistoryState === 'ready' && replenishRows.length === 0) ? (
              <p className="muted">
                {replenishAll.length > 0
                  ? 'No Public → Private auto-funding on this chain.'
                  : 'No Public → Private auto-funding transactions yet.'}
              </p>
            ) : null}
            {treasuryFundingHistoryState === 'ready' && replenishRows.length > 0 ? (
              <ReplenishRows rows={replenishRows} />
            ) : null}
          </div>
        </CollapsibleSection>
      )}
    </section>
  );
}
