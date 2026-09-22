import { useEffect, useState, type FormEvent } from 'react';
import {
  createDashboardUser,
  listApiCredentials,
  listDashboardUsers,
  mutateApiCredential,
  updateDashboardUser,
  type ApiCredentialResource,
  type DashboardRole,
  type DashboardUserResource,
} from '../api';
import { formatError, formatTimestamp } from '../dashboard-shared';
import { DataTable } from '../primitives';
import { ChangePasswordForm } from '../session/change-password-form';
import { useHasPermission } from '../session/permissions';

const ROLES: readonly DashboardRole[] = ['admin', 'operator', 'viewer'];
const MINIMUM_PASSWORD_LENGTH = 12;

export function AdminUnavailable() {
  return (
    <section className="panel">
      <h2 className="section-title">Admin</h2>
      <p>Admin is available to administrators</p>
    </section>
  );
}

export function AdminPage(props: { readonly currentUserId: string }) {
  return (
    <>
      <UsersSection currentUserId={props.currentUserId} />
      <CredentialsSection />
      <section className="panel">
        <h2 className="section-title">Account</h2>
        <ChangePasswordForm />
      </section>
    </>
  );
}

function UsersSection(props: { readonly currentUserId: string }) {
  const canManage = useHasPermission('user:manage');
  const [users, setUsers] = useState<readonly DashboardUserResource[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  async function reload(): Promise<void> {
    setState('loading');
    setError(undefined);
    try {
      const page = await listDashboardUsers();
      setUsers(page.data);
      setState('ready');
    } catch (caught) {
      setError(formatError(caught));
      setState('error');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <section className="panel">
      <h2 className="section-title">Users</h2>
      {state === 'loading' ? <p className="muted">Loading users…</p> : null}
      {error !== undefined ? <p className="error-inline">{error}</p> : null}
      {message !== undefined ? <p className="hint">{message}</p> : null}
      {state === 'ready' ? (
        <DataTable caption="Dashboard users">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Enabled</th>
              <th>Last login</th>
              {canManage ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === props.currentUserId}
                canManage={canManage}
                onChanged={(text) => {
                  setMessage(text);
                  void reload();
                }}
                onError={setError}
              />
            ))}
          </tbody>
        </DataTable>
      ) : null}
      {canManage ? (
        <CreateUserForm
          onCreated={(text) => {
            setMessage(text);
            void reload();
          }}
          onError={setError}
        />
      ) : null}
    </section>
  );
}

function UserRow(props: {
  readonly user: DashboardUserResource;
  readonly isSelf: boolean;
  readonly canManage: boolean;
  readonly onChanged: (message: string) => void;
  readonly onError: (message: string) => void;
}) {
  const { user, isSelf, canManage } = props;
  const [role, setRole] = useState<DashboardRole>(user.role);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    try {
      props.onChanged(await work());
    } catch (caught) {
      props.onError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{user.email}</td>
      <td>{user.displayName}</td>
      <td>{user.role}</td>
      <td>{user.enabled ? 'enabled' : 'disabled'}</td>
      <td>{formatTimestamp(user.lastLoginAt)}</td>
      {canManage ? (
        <td className="admin-actions">
          {isSelf ? null : (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const updated = await updateDashboardUser(user.id, { enabled: !user.enabled });
                  return `${updated.email} is now ${updated.enabled ? 'enabled' : 'disabled'}.`;
                })
              }
            >
              {user.enabled ? 'Disable' : 'Enable'}
            </button>
          )}
          {isSelf ? null : (
            <>
              <label className="visually-hidden" htmlFor={`role-${user.id}`}>
                Role for {user.email}
              </label>
              <select
                id={`role-${user.id}`}
                value={role}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === 'admin' || next === 'operator' || next === 'viewer') {
                    setRole(next);
                  }
                }}
              >
                {ROLES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary"
                disabled={busy || role === user.role}
                onClick={() =>
                  void run(async () => {
                    const updated = await updateDashboardUser(user.id, { role });
                    return `${updated.email} is now ${updated.role}.`;
                  })
                }
              >
                Change role
              </button>
            </>
          )}
          <label className="visually-hidden" htmlFor={`reset-${user.id}`}>
            New password for {user.email}
          </label>
          <input
            id={`reset-${user.id}`}
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            disabled={busy}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy || password.length < MINIMUM_PASSWORD_LENGTH}
            onClick={() =>
              void run(async () => {
                await updateDashboardUser(user.id, { password });
                setPassword('');
                return `Password reset for ${user.email}. Their sessions were signed out.`;
              })
            }
          >
            Reset password
          </button>
        </td>
      ) : null}
    </tr>
  );
}

function CreateUserForm(props: {
  readonly onCreated: (message: string) => void;
  readonly onError: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<DashboardRole>('viewer');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setFormError(`Initial password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`);
      return;
    }
    setBusy(true);
    setFormError(undefined);
    try {
      const created = await createDashboardUser({
        email: email.trim(),
        displayName: displayName.trim(),
        role,
        password,
      });
      setEmail('');
      setDisplayName('');
      setRole('viewer');
      setPassword('');
      props.onCreated(`Created ${created.email}.`);
    } catch (caught) {
      const message = formatError(caught);
      setFormError(message);
      props.onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-create" onSubmit={(event) => void onSubmit(event)}>
      <h3>Create user</h3>
      <label htmlFor="new-user-email">Email</label>
      <input
        id="new-user-email"
        type="email"
        required
        autoComplete="off"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <label htmlFor="new-user-name">Display name</label>
      <input
        id="new-user-name"
        type="text"
        required
        value={displayName}
        onChange={(event) => {
          setDisplayName(event.target.value);
        }}
      />
      <label htmlFor="new-user-role">Role</label>
      <select
        id="new-user-role"
        value={role}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'admin' || next === 'operator' || next === 'viewer') {
            setRole(next);
          }
        }}
      >
        {ROLES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <label htmlFor="new-user-password">Initial password</label>
      <input
        id="new-user-password"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      {formError !== undefined ? <p className="error-inline">{formError}</p> : null}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}

function CredentialsSection() {
  const canWrite = useHasPermission('credential:write');
  const [credentials, setCredentials] = useState<readonly ApiCredentialResource[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();

  async function reload(): Promise<void> {
    setState('loading');
    setError(undefined);
    try {
      const page = await listApiCredentials();
      setCredentials(page.data);
      setState('ready');
    } catch (caught) {
      setError(formatError(caught));
      setState('error');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function act(
    credential: ApiCredentialResource,
    action: 'enable' | 'disable' | 'revoke',
  ): Promise<void> {
    setBusyId(credential.id);
    setError(undefined);
    try {
      await mutateApiCredential(credential.id, action);
      await reload();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="panel">
      <h2 className="section-title">API credentials</h2>
      <p className="hint">New credentials are issued with npm run credential:issue on the server.</p>
      {state === 'loading' ? <p className="muted">Loading credentials…</p> : null}
      {error !== undefined ? <p className="error-inline">{error}</p> : null}
      {state === 'ready' ? (
        <DataTable caption="API credentials">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Token prefix</th>
              <th>Enabled</th>
              <th>Last used</th>
              {canWrite ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {credentials.map((credential) => {
              const revoked = credential.revokedAt !== null;
              return (
                <tr key={credential.id}>
                  <td>{credential.name}</td>
                  <td>{credential.role}</td>
                  <td className="mono">{credential.tokenPrefix}</td>
                  <td>{revoked ? 'revoked' : credential.enabled ? 'enabled' : 'disabled'}</td>
                  <td>{formatTimestamp(credential.lastUsedAt)}</td>
                  {canWrite ? (
                    <td className="admin-actions">
                      {revoked ? null : (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyId === credential.id}
                            onClick={() => void act(credential, credential.enabled ? 'disable' : 'enable')}
                          >
                            {credential.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busyId === credential.id}
                            onClick={() => void act(credential, 'revoke')}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      ) : null}
    </section>
  );
}
