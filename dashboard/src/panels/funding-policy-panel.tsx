import type { ManagedWalletResource } from '../api';
import { formatTimestamp, formatWeiAsEther, type LoadState } from '../dashboard-shared';

export type FundingPolicyPanelProps = {
  readonly loadPolicyPanel: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly selectedProjectId: string;
  readonly policyState: LoadState;
  readonly policyError: string | undefined;
  readonly policyWalletsTotal: number;
  readonly policyWallets: readonly ManagedWalletResource[];
  readonly editingWalletId: string | undefined;
  readonly beginEditPolicy: (wallet: ManagedWalletResource) => void;
  readonly minimumEtherInput: string;
  readonly setMinimumEtherInput: (value: string) => void;
  readonly targetEtherInput: string;
  readonly setTargetEtherInput: (value: string) => void;
  readonly maximumEtherInput: string;
  readonly setMaximumEtherInput: (value: string) => void;
  readonly policyPreview:
    | {
        readonly ok: true;
        readonly minimumBalanceWei: string;
        readonly targetBalanceWei: string;
        readonly maximumTopUpWei: string;
      }
    | { readonly ok: false; readonly message: string }
    | undefined;
  readonly policyPreviewError: string | undefined;
  readonly policyBusyId: string | undefined;
  readonly onSavePolicy: (wallet: ManagedWalletResource) => Promise<void>;
  readonly setEditingWalletId: (value: string | undefined) => void;
  readonly setPolicyPreviewError: (value: string | undefined) => void;
};

export function FundingPolicyPanel({ loadPolicyPanel, token, selectedProjectId, policyState, policyError, policyWalletsTotal, policyWallets, editingWalletId, beginEditPolicy, minimumEtherInput, setMinimumEtherInput, targetEtherInput, setTargetEtherInput, maximumEtherInput, setMaximumEtherInput, policyPreview, policyPreviewError, policyBusyId, onSavePolicy, setEditingWalletId, setPolicyPreviewError }) {
  return (
<section className="panel">
  <div className="panel-head">
    <h2 className="section-title">Funding policy</h2>
    <button type="button" className="secondary" onClick={() => void loadPolicyPanel(token)}>
      Reload
    </button>
  </div>
  {token === '' ? (
    <p className="muted">Paste an operator token to load funding policies.</p>
  ) : null}
  {token !== '' ? (
    <>
      <p className="hint">
        Amounts are entered in ETH and converted once to exact decimal wei strings before
        submit. Confirm shows the wei values the API will receive.
        {selectedProjectId !== '' ? ' Scoped to the selected project.' : ''}
      </p>
      {policyState === 'loading' ? <p className="muted">Loading…</p> : null}
      {policyState === 'error' ? <p className="error-inline">{policyError}</p> : null}
      {policyState === 'empty' ? (
        <p className="muted">
          No wallets returned for policy view ({String(policyWalletsTotal)} total).
        </p>
      ) : null}
      {policyState === 'ready' ? (
        <div className="policy-list">
          {policyWallets.map((wallet) => {
            const isEditing = editingWalletId === wallet.id;
            return (
              <article key={wallet.id} className="treasury">
                <div className="treasury-head">
                  <h3>
                    {wallet.role}{' '}
                    <span className="muted">
                      · {wallet.project.slug}/{wallet.environment.slug}
                    </span>
                  </h3>
                </div>
                <p className="mono">
                  <a href={wallet.explorerUrl} target="_blank" rel="noreferrer">
                    {wallet.address}
                  </a>
                </p>
                {wallet.policy === null ? (
                  <p className="muted">No funding policy set.</p>
                ) : (
                  <dl className="facts">
                    <div>
                      <dt>Minimum</dt>
                      <dd className="mono">
                        {formatWeiAsEther(wallet.policy.minimumBalanceWei)} ETH
                        <div className="muted tiny">{wallet.policy.minimumBalanceWei} wei</div>
                      </dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd className="mono">
                        {formatWeiAsEther(wallet.policy.targetBalanceWei)} ETH
                        <div className="muted tiny">{wallet.policy.targetBalanceWei} wei</div>
                      </dd>
                    </div>
                    <div>
                      <dt>Maximum top-up</dt>
                      <dd className="mono">
                        {formatWeiAsEther(wallet.policy.maximumTopUpWei)} ETH
                        <div className="muted tiny">{wallet.policy.maximumTopUpWei} wei</div>
                      </dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd>
                        v{String(wallet.policy.version)} · updated{' '}
                        {formatTimestamp(wallet.policy.updatedAt)}
                      </dd>
                    </div>
                  </dl>
                )}
                {!isEditing ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => beginEditPolicy(wallet)}
                  >
                    Edit policy
                  </button>
                ) : (
                  <div className="policy-form">
                    <div className="filters row">
                      <label htmlFor={`min-${wallet.id}`}>Minimum (ETH)</label>
                      <input
                        id={`min-${wallet.id}`}
                        type="text"
                        inputMode="decimal"
                        spellCheck={false}
                        value={minimumEtherInput}
                        onChange={(event) => {
                          setMinimumEtherInput(event.target.value);
                          setPolicyPreviewError(undefined);
                        }}
                      />
                      <label htmlFor={`target-${wallet.id}`}>Target (ETH)</label>
                      <input
                        id={`target-${wallet.id}`}
                        type="text"
                        inputMode="decimal"
                        spellCheck={false}
                        value={targetEtherInput}
                        onChange={(event) => {
                          setTargetEtherInput(event.target.value);
                          setPolicyPreviewError(undefined);
                        }}
                      />
                      <label htmlFor={`max-${wallet.id}`}>Max top-up (ETH)</label>
                      <input
                        id={`max-${wallet.id}`}
                        type="text"
                        inputMode="decimal"
                        spellCheck={false}
                        value={maximumEtherInput}
                        onChange={(event) => {
                          setMaximumEtherInput(event.target.value);
                          setPolicyPreviewError(undefined);
                        }}
                      />
                    </div>
                    {policyPreview !== undefined && policyPreview.ok ? (
                      <pre className="wei-preview">
                        {`minimumBalanceWei: ${policyPreview.minimumBalanceWei}\ntargetBalanceWei: ${policyPreview.targetBalanceWei}\nmaximumTopUpWei: ${policyPreview.maximumTopUpWei}`}
                      </pre>
                    ) : null}
                    {policyPreviewError !== undefined ? (
                      <p className="error-inline">{policyPreviewError}</p>
                    ) : null}
                    {policyPreview !== undefined && !policyPreview.ok ? (
                      <p className="error-inline">{policyPreview.message}</p>
                    ) : null}
                    <div className="row">
                      <button
                        type="button"
                        disabled={policyBusyId === wallet.id}
                        onClick={() => void onSavePolicy(wallet)}
                      >
                        Save policy
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={policyBusyId === wallet.id}
                        onClick={() => {
                          setEditingWalletId(undefined);
                          setPolicyPreviewError(undefined);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
    </>
  ) : null}
</section>
  );
}
