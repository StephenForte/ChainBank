import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiClientError,
  checkTreasury,
  fetchReadiness,
  listTreasuries,
  sendTestEmail,
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
      return 'badge badge-ok';
    case 'warning':
    case 'degraded':
      return 'badge badge-warn';
    case 'critical':
    case 'failed':
      return 'badge badge-bad';
    default:
      return 'badge badge-unknown';
  }
}

export function App() {
  const [tokenInput, setTokenInput] = useState(loadStoredToken);
  const [token, setToken] = useState(loadStoredToken);
  const [readiness, setReadiness] = useState<ReadinessResponse | undefined>();
  const [treasuries, setTreasuries] = useState<readonly TreasuryResource[]>([]);
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
        const nextTreasuries = await listTreasuries(activeToken.trim());
        setTreasuries(nextTreasuries);
      } else {
        setTreasuries([]);
      }
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh(token);
  }, [token]);

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

      {message !== undefined ? <p className="toast ok">{message}</p> : null}
      {error !== undefined ? <p className="toast bad">{error}</p> : null}
    </div>
  );
}
