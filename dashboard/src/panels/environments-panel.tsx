import type { EnvironmentResource } from '../api';
import { enabledBadge, formatTimestamp, type LoadState } from '../dashboard-shared';

export type EnvironmentsPanelProps = {
  readonly loadProjectEnvironments: (activeToken: string, projectId: string) => Promise<void>;
  readonly loadEnvironmentDetail: (activeToken: string, environmentId: string) => Promise<void>;
  readonly token: string;
  readonly selectedProjectId: string;
  readonly envLookupId: string;
  readonly setEnvLookupId: (value: string) => void;
  readonly envListState: LoadState;
  readonly envListError: string | undefined;
  readonly projectEnvironments: readonly EnvironmentResource[];
  readonly environmentState: LoadState;
  readonly environmentError: string | undefined;
  readonly environmentDetail: EnvironmentResource | undefined;
  readonly environmentBusy: boolean;
  readonly onToggleEnvironment: (environment: EnvironmentResource) => Promise<void>;
};

export function EnvironmentsPanel({ loadProjectEnvironments, loadEnvironmentDetail, token, selectedProjectId, envLookupId, setEnvLookupId, envListState, envListError, projectEnvironments, environmentState, environmentError, environmentDetail, environmentBusy, onToggleEnvironment }) {
  return (
<section className="panel">
  <div className="panel-head">
    <h2 className="section-title">Environments</h2>
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void loadProjectEnvironments(token, selectedProjectId);
        if (envLookupId.trim() !== '') {
          void loadEnvironmentDetail(token, envLookupId);
        }
      }}
    >
      Reload
    </button>
  </div>
  {token === '' ? <p className="muted">Paste an operator token to load environments.</p> : null}
  {token !== '' && selectedProjectId === '' ? (
    <p className="muted">Select a project above to list its environments.</p>
  ) : null}
  {token !== '' && selectedProjectId !== '' ? (
    <>
      <p className="hint">
        Load any environment by UUID below for full detail and enable/disable.
      </p>
      {envListState === 'loading' ? <p className="muted">Loading environments…</p> : null}
      {envListState === 'error' ? <p className="error-inline">{envListError}</p> : null}
      {envListState === 'empty' ? (
        <p className="muted">No environments registered for this project yet.</p>
      ) : null}
      {envListState === 'ready' ? (
        <ul className="plain env-list">
          {projectEnvironments.map((environment) => (
            <li key={environment.id}>
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setEnvLookupId(environment.id);
                  void loadEnvironmentDetail(token, environment.id);
                }}
              >
                <code>{environment.slug}</code>
              </button>{' '}
              <span className={enabledBadge(environment.enabled)}>
                {environment.enabled ? 'enabled' : 'disabled'}
              </span>
              <span className="muted"> — {environment.name}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="filters row"
        onSubmit={(event) => {
          event.preventDefault();
          void loadEnvironmentDetail(token, envLookupId);
        }}
      >
        <label htmlFor="environment-id">Environment ID</label>
        <input
          id="environment-id"
          name="environment-id"
          type="text"
          spellCheck={false}
          placeholder="UUID"
          value={envLookupId}
          onChange={(event) => setEnvLookupId(event.target.value)}
        />
        <button type="submit">Load detail</button>
      </form>

      {environmentState === 'loading' ? (
        <p className="muted">Loading environment detail…</p>
      ) : null}
      {environmentState === 'error' ? <p className="error-inline">{environmentError}</p> : null}
      {environmentState === 'ready' && environmentDetail !== undefined ? (
        <article className="treasury">
          <div className="treasury-head">
            <span className={enabledBadge(environmentDetail.enabled)}>
              {environmentDetail.enabled ? 'enabled' : 'disabled'}
            </span>
            <h3>
              {environmentDetail.slug} <span className="muted">· {environmentDetail.name}</span>
            </h3>
          </div>
          <dl className="facts">
            <div>
              <dt>ID</dt>
              <dd className="mono">{environmentDetail.id}</dd>
            </div>
            <div>
              <dt>Project ID</dt>
              <dd className="mono">{environmentDetail.projectId}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatTimestamp(environmentDetail.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatTimestamp(environmentDetail.updatedAt)}</dd>
            </div>
          </dl>
          <button
            type="button"
            className={environmentDetail.enabled ? 'secondary' : undefined}
            disabled={environmentBusy}
            onClick={() => void onToggleEnvironment(environmentDetail)}
          >
            {environmentDetail.enabled ? 'Disable' : 'Enable'}
          </button>
        </article>
      ) : null}
    </>
  ) : null}
</section>
  );
}
