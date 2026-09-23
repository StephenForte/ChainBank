import type { ReactNode } from 'react';
import type { ManagedWalletResource } from '../../api';
import { matchesChainFilter, type VisibleChainIds } from '../../chain-filter';
import { CollapsibleSection, COLLAPSE_STORAGE_KEYS } from '../../collapsible-section';
import * as dash from '../../dashboard-shared';
import type { LoadState, WalletBalanceView } from '../../dashboard-shared';
import { useHasPermission } from '../../session/permissions';

export type ManagedWalletsPanelProps = {
  readonly checkListedWalletBalances: () => Promise<void>;
  readonly loadWalletsPanel: () => Promise<void>;
  readonly walletsState: LoadState;
  readonly balancesBusy: boolean;
  readonly walletProjectFilter: string;
  readonly setWalletProjectFilter: (value: string) => void;
  readonly walletEnvironmentFilter: string;
  readonly setWalletEnvironmentFilter: (value: string) => void;
  readonly walletEnabledFilter: string;
  readonly setWalletEnabledFilter: (value: string) => void;
  readonly selectedProjectId: string;
  readonly walletsError: string | undefined;
  readonly walletsTotal: number;
  readonly wallets: readonly ManagedWalletResource[];
  readonly walletBalances: Readonly<Record<string, WalletBalanceView>>;
  readonly fetchOneWalletBalance: (walletId: string) => Promise<void>;
  readonly walletBusyId: string | undefined;
  readonly onToggleWallet: (wallet: ManagedWalletResource) => Promise<void>;
  readonly onToggleWalletReconciliation: (wallet: ManagedWalletResource) => Promise<void>;
  /** Absent means every chain, so existing callers keep today's rows. */
  readonly visibleChainIds?: VisibleChainIds;
};

/**
 * Plain-English cron outcome. Mirrors isEligibleForReconciliation
 * (src/app/reconciliation/reconciliation-decisions.ts): the sweep funds a
 * wallet only when the wallet, its reconcile flag, its project, and its
 * environment are all enabled. A disabled wallet keeps the disabled badge
 * alone: enablement is the gate. "not auto-funded" is the case an operator
 * read as a failed cron when the green enabled badge sat next to muted
 * "reconcile off".
 */
function autoFundingBadge(wallet: {
  readonly enabled: boolean;
  readonly reconciliationEnabled: boolean;
  readonly project: { readonly enabled: boolean };
  readonly environment: { readonly enabled: boolean };
}): ReactNode {
  if (!wallet.enabled) {
    return null;
  }
  const reason = !wallet.reconciliationEnabled
    ? 'Reconcile is off'
    : !wallet.project.enabled
      ? 'Project is disabled'
      : !wallet.environment.enabled
        ? 'Environment is disabled'
        : undefined;
  if (reason === undefined) {
    return <span className="badge badge-ok">auto-funded</span>;
  }
  return (
    <span className="badge badge-warn" title={reason}>
      not auto-funded
    </span>
  );
}

export function ManagedWalletsPanel({
  checkListedWalletBalances,
  loadWalletsPanel,
  walletsState,
  balancesBusy,
  walletProjectFilter,
  setWalletProjectFilter,
  walletEnvironmentFilter,
  setWalletEnvironmentFilter,
  walletEnabledFilter,
  setWalletEnabledFilter,
  selectedProjectId,
  walletsError,
  walletsTotal,
  wallets,
  walletBalances,
  fetchOneWalletBalance,
  walletBusyId,
  onToggleWallet,
  onToggleWalletReconciliation,
  visibleChainIds = 'ALL',
}: ManagedWalletsPanelProps) {
  const canWrite = useHasPermission('wallet:write');
  const listed = wallets.filter((wallet) => matchesChainFilter(wallet, visibleChainIds));
  const { enabled, disabled } = dash.partitionByEnabled(listed);
  const showDisabledInline = walletEnabledFilter === 'false';
  const visibleWallets = showDisabledInline ? listed : enabled;
  const chainsMixed = dash.listSpansMultipleChains(listed);

  function renderWalletRow(wallet: ManagedWalletResource) {
    const balanceView = walletBalances[wallet.id];
    return (
      <tr key={wallet.id}>
        <td>
          <strong>{wallet.project.slug}</strong>
          <span className="muted"> / {wallet.environment.slug}</span>
        </td>
        <td>
          {wallet.role}
          {chainsMixed ? <div className="muted tiny">{wallet.chain.displayName}</div> : null}
        </td>
        <td className="mono">
          <a href={wallet.explorerUrl} target="_blank" rel="noreferrer" title={wallet.address}>
            {dash.shortAddress(wallet.address)}
          </a>
        </td>
        <td>
          {balanceView === undefined ? (
            <button
              type="button"
              className="secondary"
              disabled={balancesBusy}
              onClick={() => void fetchOneWalletBalance(wallet.id)}
            >
              Check
            </button>
          ) : null}
          {balanceView?.status === 'loading' ? <span className="muted">Checking…</span> : null}
          {balanceView?.status === 'observed' ? (
            <>
              <span className="mono">{balanceView.ether} ETH</span>{' '}
              {(() => {
                const chip = dash.balancePolicyChip(balanceView.wei, wallet.policy?.minimumBalanceWei);
                return <span className={chip.className}>{chip.label}</span>;
              })()}
              <div className="muted tiny" title={`Observed at ${balanceView.observedAt}`}>
                as of {dash.formatClockTime(balanceView.observedAt)}
              </div>
            </>
          ) : null}
          {balanceView?.status === 'unavailable' ? (
            <>
              <span className="badge badge-unknown">unavailable</span>
              <div className="muted tiny" title={balanceView.errorCode}>
                as of {dash.formatClockTime(balanceView.observedAt)}
              </div>
            </>
          ) : null}
          {balanceView?.status === 'error' ? (
            <span className="error-inline" title={balanceView.message}>
              error
            </span>
          ) : null}
        </td>
        <td className="muted">
          startup {wallet.criticalAtStartup ? 'critical' : 'optional'}
          <br />
          reconcile {wallet.reconciliationEnabled ? 'on' : 'off'}
        </td>
        <td>
          <span className={dash.enabledBadge(wallet.enabled)}>{wallet.enabled ? 'enabled' : 'disabled'}</span>{' '}
          {autoFundingBadge(wallet)}
        </td>
        <td>
          {canWrite ? (
            <>
              <button
                type="button"
                className={wallet.enabled ? 'secondary' : undefined}
                disabled={walletBusyId === wallet.id}
                onClick={() => void onToggleWallet(wallet)}
              >
                {wallet.enabled ? 'Disable' : 'Enable'}
              </button>{' '}
              <button
                type="button"
                className={wallet.reconciliationEnabled ? 'secondary' : undefined}
                disabled={walletBusyId === wallet.id}
                onClick={() => void onToggleWalletReconciliation(wallet)}
              >
                {wallet.reconciliationEnabled ? 'Disable reconcile' : 'Enable reconcile'}
              </button>
            </>
          ) : null}
        </td>
      </tr>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Managed wallets</h2>
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={walletsState !== 'ready' || balancesBusy}
            onClick={() => void checkListedWalletBalances()}
          >
            {balancesBusy ? 'Checking…' : 'Check balances'}
          </button>
          <button type="button" className="secondary" onClick={() => void loadWalletsPanel()}>
            Reload
          </button>
        </div>
      </div>
      <>
        <div className="filters row">
          <label htmlFor="wallet-project">Project ID</label>
          <input
            id="wallet-project"
            name="wallet-project"
            type="text"
            spellCheck={false}
            placeholder="UUID (optional)"
            value={walletProjectFilter}
            onChange={(event) => setWalletProjectFilter(event.target.value)}
          />
          <label htmlFor="wallet-environment">Environment ID</label>
          <input
            id="wallet-environment"
            name="wallet-environment"
            type="text"
            spellCheck={false}
            placeholder="UUID (optional)"
            value={walletEnvironmentFilter}
            onChange={(event) => setWalletEnvironmentFilter(event.target.value)}
          />
          <label htmlFor="wallet-enabled">Enabled</label>
          <select
            id="wallet-enabled"
            name="wallet-enabled"
            value={walletEnabledFilter}
            onChange={(event) => setWalletEnabledFilter(event.target.value)}
          >
            <option value="">All</option>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </select>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (selectedProjectId !== '') {
                setWalletProjectFilter(selectedProjectId);
              }
            }}
          >
            Use selected project
          </button>
        </div>
        {walletsState === 'loading' ? <p className="muted">Loading…</p> : null}
        {walletsState === 'error' ? <p className="error-inline">{walletsError}</p> : null}
        {walletsState === 'empty' ? (
          <p className="muted">No managed wallets returned ({String(walletsTotal)} total).</p>
        ) : null}
        {walletsState === 'ready' && wallets.length > 0 && listed.length === 0 ? (
          <p className="muted">
            {walletsTotal > wallets.length
              ? 'No managed wallets for this chain on the loaded page.'
              : 'No managed wallets on this chain.'}
          </p>
        ) : null}
        {walletsState === 'ready' && listed.length > 0 ? (
          <>
            <p className="muted">
              Showing {String(visibleWallets.length)} enabled of {String(listed.length)} on this chain (
              {String(walletsTotal)} total)
              {disabled.length > 0 && !showDisabledInline
                ? ` · ${String(disabled.length)} disabled hidden`
                : ''}
              .
              {wallets.length <= dash.BALANCE_AUTO_LOAD_MAX
                ? ' Balances load automatically for this list (one live RPC read each); Check balances refreshes.'
                : ` Balances are not auto-loaded above ${String(dash.BALANCE_AUTO_LOAD_MAX)} listed wallets (one live RPC read each). Use Check balances.`}
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Project / env</th>
                    <th>Role</th>
                    <th>Address</th>
                    <th>Balance</th>
                    <th>Flags</th>
                    <th>Enabled</th>
                    <th />
                  </tr>
                </thead>
                <tbody>{visibleWallets.map(renderWalletRow)}</tbody>
              </table>
            </div>
            {!showDisabledInline ? (
              <CollapsibleSection
                title="Disabled wallets"
                count={disabled.length}
                storageKey={COLLAPSE_STORAGE_KEYS.disabledWallets}
              >
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Project / env</th>
                        <th>Role</th>
                        <th>Address</th>
                        <th>Balance</th>
                        <th>Flags</th>
                        <th>Enabled</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>{disabled.map(renderWalletRow)}</tbody>
                  </table>
                </div>
              </CollapsibleSection>
            ) : null}
          </>
        ) : null}
      </>
    </section>
  );
}
