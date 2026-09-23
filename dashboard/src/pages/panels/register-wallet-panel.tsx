import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { getAddress, isAddress } from 'viem';
import {
  registerWallet,
  type EnvironmentResource,
  type ProjectResource,
  type RegisterWalletRequest,
} from '../../api';
import type { ChainSegment } from '../../chain-filter';
import { formatError, type LoadState } from '../../dashboard-shared';
import { useHasPermission } from '../../session/permissions';

/** The values the confirm step showed. The POST body is this object and nothing else. */
export type RegisteredWallet = RegisterWalletRequest;

export type RegisterWalletPanelProps = {
  readonly projects: readonly ProjectResource[];
  readonly projectId: string;
  readonly onProjectChange: (projectId: string) => void;
  readonly environments: readonly EnvironmentResource[];
  readonly environmentsState: LoadState;
  readonly environmentsError: string | undefined;
  readonly chains: readonly ChainSegment[];
  readonly onRegistered: (registered: RegisteredWallet) => void;
};

type PendingRegistration = RegisteredWallet & {
  readonly chainDisplayName: string;
  readonly projectSlug: string;
  readonly environmentSlug: string;
};

type AddressCheck =
  { readonly ok: true; readonly address: string } | { readonly ok: false; readonly message: string };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Accepts 0x plus 40 hex digits. All-lower and all-upper have no checksum.
 * Mixed case must already be the EIP-55 form, which is how a typo is caught.
 * The returned address is the checksummed form the confirm step and the POST share.
 */
function checksummedAddress(raw: string): AddressCheck {
  const trimmed = raw.trim();
  if (!HEX_ADDRESS.test(trimmed)) {
    return { ok: false, message: 'Enter an address that is 0x followed by 40 hex digits.' };
  }
  const hex = trimmed.slice(2);
  const isMixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (isMixedCase && !isAddress(trimmed)) {
    return { ok: false, message: 'That address has an invalid checksum. Check it for a typo.' };
  }
  try {
    return { ok: true, address: getAddress(trimmed) };
  } catch {
    return { ok: false, message: 'That address has an invalid checksum. Check it for a typo.' };
  }
}

export function RegisterWalletPanel(props: RegisterWalletPanelProps): ReactNode {
  const canWrite = useHasPermission('wallet:write');
  const [environmentId, setEnvironmentId] = useState('');
  const [chainIdValue, setChainIdValue] = useState('');
  const [role, setRole] = useState('');
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState<PendingRegistration | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    setEnvironmentId('');
    setPending(undefined);
  }, [props.projectId]);

  if (!canWrite) {
    return null;
  }

  const environmentChoices = props.environments.filter(
    (environment) => environment.projectId === props.projectId,
  );
  const fieldsLocked = pending !== undefined || isSubmitting;

  function review(): void {
    setNotice(undefined);
    const project = props.projects.find((item) => item.id === props.projectId);
    if (project === undefined) {
      setFormError('Choose a project.');
      setPending(undefined);
      return;
    }
    const environment = environmentChoices.find((item) => item.id === environmentId);
    if (environment === undefined || environment.projectId !== project.id) {
      setFormError('Choose an environment in this project.');
      setPending(undefined);
      return;
    }
    const chain = props.chains.find((item) => String(item.chainId) === chainIdValue);
    if (chain === undefined) {
      setFormError('Choose a registered chain.');
      setPending(undefined);
      return;
    }
    const walletRole = role.trim();
    if (walletRole.length === 0) {
      setFormError('A wallet role is required.');
      setPending(undefined);
      return;
    }
    if (walletRole.length > 64) {
      setFormError('A wallet role must be 64 characters or fewer.');
      setPending(undefined);
      return;
    }
    const checked = checksummedAddress(address);
    if (!checked.ok) {
      setFormError(checked.message);
      setPending(undefined);
      return;
    }
    setFormError(undefined);
    setPending({
      projectId: project.id,
      environmentId: environment.id,
      chainId: chain.chainId,
      role: walletRole,
      address: checked.address,
      chainDisplayName: chain.displayName,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });
  }

  async function commit(confirmed: PendingRegistration): Promise<void> {
    if (isSubmittingRef.current) {
      return;
    }
    const registered: RegisteredWallet = {
      projectId: confirmed.projectId,
      environmentId: confirmed.environmentId,
      chainId: confirmed.chainId,
      role: confirmed.role,
      address: confirmed.address,
    };
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setFormError(undefined);
    try {
      await registerWallet(registered);
    } catch (caught) {
      setFormError(formatError(caught));
      return;
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
    setPending(undefined);
    setAddress('');
    setRole('');
    setNotice('Registered. Set a policy, then enable reconcile, before this wallet can be funded.');
    props.onRegistered(registered);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending === undefined) {
      review();
      return;
    }
    void commit(pending);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Register a wallet</h2>
      </div>
      <form className="admin-create" onSubmit={onSubmit}>
        <label htmlFor="register-project">Project</label>
        <select
          id="register-project"
          name="register-project"
          value={props.projectId}
          disabled={fieldsLocked}
          onChange={(event) => {
            setFormError(undefined);
            props.onProjectChange(event.target.value);
          }}
        >
          <option value="">Choose a project</option>
          {props.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.slug} — {project.name}
            </option>
          ))}
        </select>
        <label htmlFor="register-environment">Environment</label>
        <select
          id="register-environment"
          name="register-environment"
          value={environmentId}
          disabled={fieldsLocked || props.projectId === '' || props.environmentsState === 'loading'}
          onChange={(event) => {
            setFormError(undefined);
            setEnvironmentId(event.target.value);
          }}
        >
          <option value="">
            {props.projectId === '' ? 'Choose a project first' : 'Choose an environment'}
          </option>
          {environmentChoices.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.slug}
            </option>
          ))}
        </select>
        {props.environmentsState === 'loading' ? <p className="muted">Loading environments…</p> : null}
        {props.environmentsState === 'error' && props.environmentsError !== undefined ? (
          <p className="error-inline">{props.environmentsError}</p>
        ) : null}
        <label htmlFor="register-chain">Chain</label>
        <select
          id="register-chain"
          name="register-chain"
          value={chainIdValue}
          disabled={fieldsLocked}
          onChange={(event) => {
            setFormError(undefined);
            setChainIdValue(event.target.value);
          }}
        >
          <option value="">Choose a chain</option>
          {props.chains.map((chain) => (
            <option key={chain.chainId} value={String(chain.chainId)}>
              {chain.displayName} ({String(chain.chainId)})
            </option>
          ))}
        </select>
        <label htmlFor="register-role">Role</label>
        <input
          id="register-role"
          name="register-role"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          disabled={fieldsLocked}
          value={role}
          onChange={(event) => {
            setFormError(undefined);
            setRole(event.target.value);
          }}
        />
        <label htmlFor="register-address">Address</label>
        <input
          id="register-address"
          name="register-address"
          type="text"
          className="mono"
          autoComplete="off"
          spellCheck={false}
          disabled={fieldsLocked}
          value={address}
          onChange={(event) => {
            setFormError(undefined);
            setAddress(event.target.value);
          }}
        />
        {pending !== undefined ? (
          <section aria-label="Confirm registration">
            <p>
              Chain: {pending.chainDisplayName} ({String(pending.chainId)})
            </p>
            <p>
              Project / environment: {pending.projectSlug} / {pending.environmentSlug}
            </p>
            <p>Role: {pending.role}</p>
            <p className="mono">Address: {pending.address}</p>
            <p className="muted">
              Reconcile stays off. Set a policy, then enable reconcile, before this wallet can be funded.
            </p>
          </section>
        ) : null}
        {formError !== undefined ? <p className="error-inline">{formError}</p> : null}
        {notice !== undefined ? <p className="hint">{notice}</p> : null}
        {pending === undefined ? (
          <button type="submit">Review registration</button>
        ) : (
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={isSubmitting}
              onClick={() => {
                setPending(undefined);
                setFormError(undefined);
              }}
            >
              Back
            </button>
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Registering…' : 'Register wallet'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
