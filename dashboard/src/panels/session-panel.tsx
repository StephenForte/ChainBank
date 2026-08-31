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
    <form className="session-inline" onSubmit={onSaveToken}>
      <label className="visually-hidden" htmlFor="token">
        Operator bearer token
      </label>
      <input
        id="token"
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Operator token"
        value={tokenInput}
        onChange={(event) => setTokenInput(event.target.value)}
      />
      <button type="submit" disabled={sessionBusy}>
        Save
      </button>
      <button
        type="button"
        className="secondary"
        disabled={sessionBusy}
        onClick={() => {
          refreshAll(token);
        }}
      >
        Refresh
      </button>
      <button
        type="button"
        className="secondary"
        disabled={sessionBusy || token === ''}
        onClick={() => void onTestEmail()}
      >
        Test email
      </button>
      <p className="hint">Session only. Never paste a private key.</p>
      {sessionError !== undefined ? <p className="error-inline">{sessionError}</p> : null}
    </form>
  );
}
