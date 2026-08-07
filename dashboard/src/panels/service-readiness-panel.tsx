import type { ReadinessResponse } from '../api';
import { statusClass, type LoadState } from '../dashboard-shared';

export type ServiceReadinessPanelProps = {
  readonly loadReadiness: () => Promise<void>;
  readonly readinessState: LoadState;
  readonly readinessError: string | undefined;
  readonly readiness: ReadinessResponse | undefined;
};

export function ServiceReadinessPanel({ loadReadiness, readinessState, readinessError, readiness }) {
  return (
<section className="panel">
  <div className="panel-head">
    <h2 className="section-title">Service readiness</h2>
    <button type="button" className="secondary" onClick={() => void loadReadiness()}>
      Reload
    </button>
  </div>
  {readinessState === 'loading' || readinessState === 'idle' ? (
    <p className="muted">Loading…</p>
  ) : null}
  {readinessState === 'error' ? <p className="error-inline">{readinessError}</p> : null}
  {readinessState === 'ready' && readiness !== undefined ? (
    <>
      <p>
        Overall <span className={statusClass(readiness.status)}>{readiness.status}</span>
        <span className="muted">
          {' '}
          · checked {new Date(readiness.checkedAt).toLocaleString()}
        </span>
      </p>
      <ul className="plain">
        {readiness.components.map((component) => (
          <li key={component.name}>
            <span className={statusClass(component.status)}>{component.status}</span>{' '}
            {component.name}
            {component.detail !== null ? (
              <span className="muted"> — {component.detail}</span>
            ) : null}
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
              <span className="muted">
                {' '}
                · {new Date(heartbeat.lastSeenAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  ) : null}
</section>
  );
}
