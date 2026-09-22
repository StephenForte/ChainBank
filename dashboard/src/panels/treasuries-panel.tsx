import type { FundingTransactionResource, TreasuryResource } from '../api';
import {
  formatTimestamp,
  isTreasuryReplenish,
  listSpansMultipleChains,
  shortAddress,
  statusClass,
  treasuryCardToneClass,
  type LoadState,
} from '../dashboard-shared';

export type TreasuriesPanelProps = {
  readonly loadTreasuries: (activeToken: string) => Promise<void>;
  readonly loadTreasuryFundingHistory: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly treasuriesState: LoadState;
  readonly treasuriesError: string | undefined;
  readonly treasuries: readonly TreasuryResource[];
  readonly treasuryBusyId: string | undefined;
  readonly onCheck: (treasuryId: string) => Promise<void>;
  readonly treasuryFundingHistoryState: LoadState;
  readonly treasuryFundingHistoryError: string | undefined;
  readonly treasuryFundingHistory: readonly FundingTransactionResource[];
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
    <div className="table-wrap">
      <table className="data-table">
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
      </table>
    </div>
  );
}

export function TreasuriesPanel({
  loadTreasuries,
  loadTreasuryFundingHistory,
  token,
  treasuriesState,
  treasuriesError,
  treasuries,
  treasuryBusyId,
  onCheck,
  treasuryFundingHistoryState,
  treasuryFundingHistoryError,
  treasuryFundingHistory,
}: TreasuriesPanelProps) {
  const replenishRows = treasuryFundingHistory.filter(isTreasuryReplenish);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Treasuries</h2>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void loadTreasuries(token);
            void loadTreasuryFundingHistory(token);
          }}
        >
          Reload
        </button>
      </div>
      {token === '' ? <p className="muted">Paste an operator token to load treasuries.</p> : null}
      {token !== '' && treasuriesState === 'loading' ? <p className="muted">Loading…</p> : null}
      {treasuriesState === 'error' ? <p className="error-inline">{treasuriesError}</p> : null}
      {treasuriesState === 'empty' ? <p className="muted">No enabled treasuries returned.</p> : null}
      {treasuriesState === 'ready' ? (
        <div className="treasury-list">
          {treasuries.map((treasury) => {
            const isOperational = treasury.kind === 'operational';
            return (
              <article key={treasury.id} className={treasuryCardToneClass(treasury.status)}>
                <div className="treasury-head">
                  <span className={statusClass(treasury.status)}>{treasury.status}</span>
                  <h3>
                    {treasuryLabel(treasury)} · {treasury.chain.displayName}
                  </h3>
                </div>
                {isOperational ? (
                  <p className="muted">
                    Auto-filled from Public when policy says so. Managed wallets spend from here.
                  </p>
                ) : (
                  <p className="muted">
                    Refill this address from a faucet or exchange. Auto-funding of Private starts from here.
                  </p>
                )}
                <p className="mono">
                  <a href={treasury.explorerUrl} target="_blank" rel="noreferrer">
                    {treasury.address}
                  </a>
                </p>
                <dl className="facts">
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
                <button
                  type="button"
                  disabled={treasuryBusyId === treasury.id}
                  onClick={() => void onCheck(treasury.id)}
                >
                  Check now
                </button>
              </article>
            );
          })}
        </div>
      ) : null}

      {token !== '' ? (
        <div className="history-mini">
          <h3>Auto-funding history</h3>
          <p className="muted">
            Public → Private replenish only. Wallet top-ups stay in Funding history. Deposits into Public are
            expected human refills and are not listed here.
          </p>
          {treasuryFundingHistoryState === 'loading' ? <p className="muted">Loading…</p> : null}
          {treasuryFundingHistoryState === 'error' ? (
            <p className="error-inline">{treasuryFundingHistoryError}</p>
          ) : null}
          {treasuryFundingHistoryState === 'empty' ||
          (treasuryFundingHistoryState === 'ready' && replenishRows.length === 0) ? (
            <p className="muted">No Public → Private auto-funding transactions yet.</p>
          ) : null}
          {treasuryFundingHistoryState === 'ready' && replenishRows.length > 0 ? (
            <ReplenishRows rows={replenishRows} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
