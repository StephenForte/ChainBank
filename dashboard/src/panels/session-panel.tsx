import type { FormEvent } from 'react';

export type SessionPanelProps = {
  readonly tokenInput: string;
  readonly setTokenInput: (value: string) => void;
  readonly sessionBusy: boolean;
  readonly onSaveToken: (event: FormEvent) => void;
  readonly refreshAll: (activeToken: string) => void;
  readonly token: string;
  readonly onTestEmail: () => Promise<void>;
  readonly sessionError: string | undefined;
};

export function SessionPanel({
  tokenInput,
  setTokenInput,
  sessionBusy,
  onSaveToken,
  refreshAll,
  token,
  onTestEmail,
  sessionError,
}: SessionPanelProps) {
  return (
    <section className="panel">
      <h2 className="section-title">Session</h2>
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
          <button type="submit" disabled={sessionBusy}>
            Save for this tab
          </button>
          <button
            type="button"
            className="secondary"
            disabled={sessionBusy}
            onClick={() => {
              refreshAll(token);
            }}
          >
            Refresh all
          </button>
          <button
            type="button"
            className="secondary"
            disabled={sessionBusy || token === ''}
            onClick={() => void onTestEmail()}
          >
            Send test email
          </button>
        </div>
        <p className="hint">Stored in sessionStorage only. Never put a private key here.</p>
        {sessionError !== undefined ? <p className="error-inline">{sessionError}</p> : null}
      </form>
    </section>
  );
}
