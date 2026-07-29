import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiClientError,
  checkTreasury,
  fetchReadiness,
  listFundingTransactions,
  listTreasuries,
  sendTestEmail,
  type FundingTransactionResource,
  type ReadinessResponse,
  type TreasuryResource,
} from './api';

const TOKEN_STORAGE_KEY = 'chainbank.operatorToken';

function loadStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token.trim() === '') {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // sessionStorage may be unavailable; the in-memory token still works.
  }
}

function formatError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message} (${error.requestId})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

function statusClass(status: string): string {
  switch (status) {
    case 'healthy':
    case 'ok':
    case 'confirmed':
    case 'succeeded':
      return 'badge badge-ok';
    case 'warning':
    case 'degraded':
    case 'submitted':
    case 'submission_unknown':
    case 'pending':
    case 'in_progress':
    case 'created':
      return 'badge badge-warn';
    case 'critical':
    case 'failed':
    case 'reverted':
    case 'abandoned':
    case 'dropped':
      return 'badge badge-bad';
    case 'replaced':
      return 'badge badge-unknown';
    default:
      return 'badge badge-unknown';
  }
}

function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return '—';
  }
  return new Date(value).toLocaleString();
}

export function App() {
  const [tokenInput, setTokenInput] = useState(loadStoredToken);
  const [token, setToken] = useState(loadStoredToken);
  const [readiness, setReadiness] = useState<ReadinessResponse | undefined>();
  const [treasuries, setTreasuries] = useState<readonly TreasuryResource[]>([]);
  const [fundingHistory, setFundingHistory] = useState<readonly FundingTransactionResource[]>([]);
  const [fundingHistoryTotal, setFundingHistoryTotal] = useState(0);
  const [historyProjectFilter, setHistoryProjectFilter] = useState('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function refresh(activeToken: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const nextReadiness = await fetchReadiness();
      setReadiness(nextReadiness);
      if (activeToken.trim() !== '') {
        const [nextTreasuries, nextHistory] = await Promise.all([
          listTreasuries(activeToken.trim()),
          listFundingTransactions(activeToken.trim(), {
            projectId: historyProjectFilter.trim() === '' ? undefined : historyProjectFilter.trim(),
            status: historyStatusFilter === '' ? undefined : historyStatusFilter,
            limit: 50,
          }),
        ]);
        setTreasuries(nextTreasuries);
        setFundingHistory(nextHistory.data);
        setFundingHistoryTotal(nextHistory.pagination.total);
      } else {
        setTreasuries([]);
        setFundingHistory([]);
        setFundingHistoryTotal(0);
      }
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh(token);
  }, [token, historyProjectFilter, historyStatusFilter]);

  function onSaveToken(event: FormEvent): void {
    event.preventDefault();
    const next = tokenInput.trim();
    storeToken(next);
    setToken(next);
    setMessage(
      next === '' ? 'Token cleared from this browser session.' : 'Token saved for this browser session.',
    );
  }

  async function onCheck(treasuryId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await checkTreasury(token, treasuryId);
      setTreasuries((current) => current.map((item) => (item.id === treasuryId ? result.data : item)));
      setMessage(`Check ${result.check.outcome} for ${result.data.address}`);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onTestEmail(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await sendTestEmail(token);
      setMessage('Test email requested. Check the operator inbox (or server logs if provider is log-only).');
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Operator console</p>
        <h1>ChainBank</h1>
        <p className="lede">
          Phase 0 is read-only: observe the Sepolia treasury, record balances, and prove email delivery. No
          process can send ETH.
        </p>
      </header>

      <section className="panel">
        <h2>Session</h2>
        <form className="token-form" onSubmit={onSaveToken}>
          <label htmlFor="token">Operator bearer token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="cb_…"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={busy}>
              Save for this tab
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void refresh(token);
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || token === ''}
              onClick={() => void onTestEmail()}
            >
              Send test email
            </button>
          </div>
          <p className="hint">Stored in sessionStorage only. Never put a private key here.</p>
        </form>
      </section>

      <section className="panel">
        <h2>Service readiness</h2>
        {readiness === undefined ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>
              Overall <span className={statusClass(readiness.status)}>{readiness.status}</span>
              <span className="muted"> · checked {new Date(readiness.checkedAt).toLocaleString()}</span>
            </p>
            <ul className="plain">
              {readiness.components.map((component) => (
                <li key={component.name}>
                  <span className={statusClass(component.status)}>{component.status}</span> {component.name}
                  {component.detail !== null ? <span className="muted"> — {component.detail}</span> : null}
                </li>
              ))}
            </ul>
            <h3>Heartbeats</h3>
            {readiness.heartbeats.length === 0 ? (
              <p className="muted">No heartbeats recorded yet.</p>
            ) : (
              <ul className="plain">
                {readiness.heartbeats.map((heartbeat) => (
                  <li key={heartbeat.serviceRole}>
                    <code>{heartbeat.serviceRole}</code>
                    <span className="muted"> · {new Date(heartbeat.lastSeenAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Treasuries</h2>
        {token === '' ? (
          <p className="muted">Paste an operator token to load treasuries.</p>
        ) : treasuries.length === 0 ? (
          <p className="muted">No enabled treasuries returned.</p>
        ) : (
          <div className="treasury-list">
            {treasuries.map((treasury) => (
              <article key={treasury.id} className="treasury">
                <div className="treasury-head">
                  <span className={statusClass(treasury.status)}>{treasury.status}</span>
                  <h3>{treasury.chain.displayName}</h3>
                </div>
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
                <button type="button" disabled={busy} onClick={() => void onCheck(treasury.id)}>
                  Check now
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Funding history</h2>
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
            {fundingHistory.length === 0 ? (
              <p className="muted">No funding transactions returned ({fundingHistoryTotal} total).</p>
            ) : (
              <>
                <p className="muted">
                  Showing {String(fundingHistory.length)} of {String(fundingHistoryTotal)} transactions
                  (newest first).
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
            )}
          </>
        )}
      </section>

      {message !== undefined ? <p className="toast ok">{message}</p> : null}
      {error !== undefined ? <p className="toast bad">{error}</p> : null}
    </div>
  );
}
