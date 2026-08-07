import type { TreasuryResource } from '../api';
import { statusClass, type LoadState } from '../dashboard-shared';

export type TreasuriesPanelProps = {
  readonly loadTreasuries: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly treasuriesState: LoadState;
  readonly treasuriesError: string | undefined;
  readonly treasuries: readonly TreasuryResource[];
  readonly treasuryBusyId: string | undefined;
  readonly onCheck: (treasuryId: string) => Promise<void>;
};

export function TreasuriesPanel({
  loadTreasuries,
  token,
  treasuriesState,
  treasuriesError,
  treasuries,
  treasuryBusyId,
  onCheck,
}: TreasuriesPanelProps) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Treasuries</h2>
        <button type="button" className="secondary" onClick={() => void loadTreasuries(token)}>
          Reload
        </button>
      </div>
      {token === '' ? <p className="muted">Paste an operator token to load treasuries.</p> : null}
      {token !== '' && treasuriesState === 'loading' ? <p className="muted">Loading…</p> : null}
      {treasuriesState === 'error' ? <p className="error-inline">{treasuriesError}</p> : null}
      {treasuriesState === 'empty' ? <p className="muted">No enabled treasuries returned.</p> : null}
      {treasuriesState === 'ready' ? (
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
              <button
                type="button"
                disabled={treasuryBusyId === treasury.id}
                onClick={() => void onCheck(treasury.id)}
              >
                Check now
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
