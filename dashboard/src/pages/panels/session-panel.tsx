import type { FormEvent } from 'react';

export type SessionPanelProps = {
  readonly tokenInput: string;
  readonly setTokenInput: (value: string) => void;
  readonly sessionBusy: boolean;
  readonly onSaveToken: (event: FormEvent) => void;
};

export function SessionPanel({ tokenInput, setTokenInput, sessionBusy, onSaveToken }: SessionPanelProps) {
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
        onChange={(event) => {
          setTokenInput(event.target.value);
        }}
      />
      <button type="submit" disabled={sessionBusy}>
        Save
      </button>
      <p className="hint">Session only. Never paste a private key.</p>
    </form>
  );
}
