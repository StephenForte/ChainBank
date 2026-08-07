import type { FundingTransactionResource } from '../api';
import { formatTimestamp, shortAddress, statusClass, type LoadState } from '../dashboard-shared';

export type FundingHistoryPanelProps = {
  readonly loadFundingHistory: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly historyProjectFilter: string;
  readonly setHistoryProjectFilter: (value: string) => void;
  readonly historyStatusFilter: string;
  readonly setHistoryStatusFilter: (value: string) => void;
  readonly fundingHistoryState: LoadState;
  readonly fundingHistoryError: string | undefined;
  readonly fundingHistoryTotal: number;
  readonly fundingHistory: readonly FundingTransactionResource[];
};

export function FundingHistoryPanel({
  loadFundingHistory,
  token,
  historyProjectFilter,
  setHistoryProjectFilter,
  historyStatusFilter,
  setHistoryStatusFilter,
  fundingHistoryState,
  fundingHistoryError,
  fundingHistoryTotal,
  fundingHistory,
}: FundingHistoryPanelProps) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Funding history</h2>
        <button type="button" className="secondary" onClick={() => void loadFundingHistory(token)}>
          Reload
        </button>
      </div>
      {token === '' ? (
        <p className="muted">Paste an operator token to load funding history.</p>
      ) : (
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
          </div>
          {fundingHistoryState === 'loading' ? <p className="muted">Loading…</p> : null}
          {fundingHistoryState === 'error' ? <p className="error-inline">{fundingHistoryError}</p> : null}
          {fundingHistoryState === 'empty' ? (
            <p className="muted">No funding transactions returned ({String(fundingHistoryTotal)} total).</p>
          ) : null}
          {fundingHistoryState === 'ready' ? (
            <>
              <p className="muted">
                Showing {String(fundingHistory.length)} of {String(fundingHistoryTotal)} transactions (newest
                first).
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Project / env</th>
                      <th>Wallet</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Transaction</th>
                      <th>Created</th>
                      <th>Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fundingHistory.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.project.slug}</strong>
                          <span className="muted"> / {row.environment.slug}</span>
                        </td>
                        <td className="mono">
                          {row.wallet.role}{' '}
                          <span title={row.wallet.address}>{shortAddress(row.wallet.address)}</span>
                        </td>
                        <td className="mono">
                          {row.amountEther} {row.chain.nativeSymbol}
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
      )}
    </section>
  );
}
