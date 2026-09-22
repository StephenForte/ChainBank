import { useState, type FormEvent } from 'react';
import { formatError } from '../dashboard-shared';

export type LoginPageProps = {
  readonly checking: boolean;
  readonly notice: string | undefined;
  readonly onLogin: (email: string, password: string) => Promise<void>;
};

export function LoginPage({ checking, notice, onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onLogin(email.trim(), password);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error ?? notice;

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={(event) => void onSubmit(event)}>
        <p className="sidebar-brand">ChainBank</p>
        <h1 className="page-title">Sign in</h1>
        {checking ? <p className="muted">Checking session…</p> : null}
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          required
          value={email}
          disabled={checking || busy}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={checking || busy}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {errorLine !== undefined ? (
          <p className="error-inline" role="alert">
            {errorLine}
          </p>
        ) : null}
        <button type="submit" disabled={checking || busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
