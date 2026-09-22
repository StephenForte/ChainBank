import type { FundingTransactionResource } from '../../api';
import { matchesChainFilter, type VisibleChainIds } from '../../chain-filter';
import {
  formatTimestamp,
  fundingTransactionKindLabel,
  listSpansMultipleChains,
  shortAddress,
  statusClass,
  type LoadState,
} from '../../dashboard-shared';

export type FundingHistoryPanelProps = {
  readonly loadFundingHistory: () => Promise<void>;
  readonly historyProjectFilter: string;
  readonly setHistoryProjectFilter: (value: string) => void;
  readonly historyStatusFilter: string;
  readonly setHistoryStatusFilter: (value: string) => void;
  readonly historyKindFilter: string;
  readonly setHistoryKindFilter: (value: string) => void;
  readonly fundingHistoryState: LoadState;
  readonly fundingHistoryError: string | undefined;
  readonly fundingHistoryTotal: number;
  readonly fundingHistory: readonly FundingTransactionResource[];
  /** Absent means every chain, so existing callers keep today's rows. */
  readonly visibleChainIds?: VisibleChainIds;
};

export function FundingHistoryPanel({
  loadFundingHistory,
  historyProjectFilter,
  setHistoryProjectFilter,
  historyStatusFilter,
  setHistoryStatusFilter,
  historyKindFilter,
  setHistoryKindFilter,
  fundingHistoryState,
  fundingHistoryError,
  fundingHistoryTotal,
  fundingHistory,
  visibleChainIds = 'ALL',
}: FundingHistoryPanelProps) {
  const visibleHistory = fundingHistory.filter((row) => matchesChainFilter(row, visibleChainIds));
  const chainsMixed = listSpansMultipleChains(visibleHistory);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Funding history</h2>
        <button type="button" className="secondary" onClick={() => void loadFundingHistory()}>
          Reload
        </button>
      </div>
      <>
        <div className="filters row">
          <label htmlFor="history-project">Project ID</label>
          <input
            id="history-project"
            name="history-project"
            type="text"
            spellCheck={false}
            placeholder="UUID (optional)"
            value={historyProjectFilter}
            onChange={(event) => setHistoryProjectFilter(event.target.value)}
          />
          <label htmlFor="history-status">Status</label>
          <select
            id="history-status"
            name="history-status"
            value={historyStatusFilter}
            onChange={(event) => setHistoryStatusFilter(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="confirmed">confirmed</option>
            <option value="submitted">submitted</option>
            <option value="submission_unknown">submission_unknown</option>
            <option value="failed">failed</option>
            <option value="reverted">reverted</option>
            <option value="replaced">replaced</option>
            <option value="dropped">dropped</option>
            <option value="created">created</option>
          </select>
          <label htmlFor="history-kind">Type</label>
          <select
            id="history-kind"
            name="history-kind"
            value={historyKindFilter}
            onChange={(event) => setHistoryKindFilter(event.target.value)}
          >
            <option value="">All types</option>
            <option value="replenish">Public → Private</option>
            <option value="wallet">Wallet top-up</option>
          </select>
        </div>
        {fundingHistoryState === 'loading' ? <p className="muted">Loading…</p> : null}
        {fundingHistoryState === 'error' ? <p className="error-inline">{fundingHistoryError}</p> : null}
        {fundingHistoryState === 'empty' ? (
          <p className="muted">No funding transactions returned ({String(fundingHistoryTotal)} total).</p>
        ) : null}
        {fundingHistoryState === 'ready' && fundingHistory.length > 0 && visibleHistory.length === 0 ? (
          <p className="muted">No funding transactions on this chain.</p>
        ) : null}
        {fundingHistoryState === 'ready' && visibleHistory.length > 0 ? (
          <>
            <p className="muted">
              Showing {String(visibleHistory.length)} of {String(fundingHistoryTotal)} transactions (newest
              first).
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Project / env</th>
                    <th>Destination</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Transaction</th>
                    <th>Created</th>
                    <th>Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map((row) => (
                    <tr key={row.id}>
                      <td>{fundingTransactionKindLabel(row)}</td>
                      <td>
                        <strong>{row.project?.slug ?? 'treasury'}</strong>
                        <span className="muted">
                          {' '}
                          / {row.environment?.slug ?? row.operation.operationType}
                        </span>
                      </td>
                      <td className="mono">
                        {row.wallet === null
                          ? row.destinationTreasury === undefined || row.destinationTreasury === null
                            ? '—'
                            : `Private ${shortAddress(row.destinationTreasury.address)}`
                          : `${row.wallet.role} `}
                        {row.wallet === null ? null : (
                          <span title={row.wallet.address}>{shortAddress(row.wallet.address)}</span>
                        )}
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
                      <td>{formatTimestamp(row.createdAt)}</td>
                      <td>{formatTimestamp(row.confirmedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </>
    </section>
  );
}
