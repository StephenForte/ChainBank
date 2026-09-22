import { useState, type FormEvent } from 'react';
import { changeOwnPassword } from '../api';
import { formatError } from '../dashboard-shared';

const MINIMUM_PASSWORD_LENGTH = 12;

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setMessage(undefined);
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`New password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await changeOwnPassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage('Password changed. Other sessions were signed out.');
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="current-password">Current password</label>
      <input
        id="current-password"
        name="current-password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => {
          setCurrentPassword(event.target.value);
        }}
      />
      <label htmlFor="new-password">New password</label>
      <input
        id="new-password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(event) => {
          setNewPassword(event.target.value);
        }}
      />
      <label htmlFor="confirm-password">Confirm new password</label>
      <input
        id="confirm-password"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(event) => {
          setConfirmPassword(event.target.value);
        }}
      />
      <p className="hint">Changing your password signs out your other sessions.</p>
      {error !== undefined ? (
        <p className="error-inline" role="alert">
          {error}
        </p>
      ) : null}
      {message !== undefined ? <p className="hint">{message}</p> : null}
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}
