import type { ManagedWalletResource } from '../api';
import * as dash from '../dashboard-shared';
import type { LoadState, WalletBalanceView } from '../dashboard-shared';

export type ManagedWalletsPanelProps = {
  readonly checkListedWalletBalances: (activeToken: string) => Promise<void>;
  readonly loadWalletsPanel: (activeToken: string) => Promise<void>;
  readonly token: string;
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
  readonly fetchOneWalletBalance: (activeToken: string, walletId: string) => Promise<void>;
  readonly walletBusyId: string | undefined;
  readonly onToggleWallet: (wallet: ManagedWalletResource) => Promise<void>;
  readonly onToggleWalletReconciliation: (wallet: ManagedWalletResource) => Promise<void>;
};

export function ManagedWalletsPanel({
  checkListedWalletBalances,
  loadWalletsPanel,
  token,
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
}: ManagedWalletsPanelProps) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Managed wallets</h2>
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={token === '' || walletsState !== 'ready' || balancesBusy}
            onClick={() => void checkListedWalletBalances(token)}
          >
            {balancesBusy ? 'Checking…' : 'Check balances'}
          </button>
          <button type="button" className="secondary" onClick={() => void loadWalletsPanel(token)}>
            Reload
          </button>
        </div>
      </div>
      {token === '' ? <p className="muted">Paste an operator token to load wallets.</p> : null}
      {token !== '' ? (
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
          {walletsState === 'ready' ? (
            <>
              <p className="muted">
                Showing {String(wallets.length)} of {String(walletsTotal)} wallets.
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
                  <tbody>
                    {wallets.map((wallet) => {
                      const balanceView = walletBalances[wallet.id];
                      return (
                        <tr key={wallet.id}>
                          <td>
                            <strong>{wallet.project.slug}</strong>
                            <span className="muted"> / {wallet.environment.slug}</span>
                          </td>
                          <td>{wallet.role}</td>
                          <td className="mono">
                            <a
                              href={wallet.explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={wallet.address}
                            >
                              {dash.shortAddress(wallet.address)}
                            </a>
                          </td>
                          <td>
                            {balanceView === undefined ? (
                              <button
                                type="button"
                                className="secondary"
                                disabled={balancesBusy}
                                onClick={() => void fetchOneWalletBalance(token, wallet.id)}
                              >
                                Check
                              </button>
                            ) : null}
                            {balanceView?.status === 'loading' ? (
                              <span className="muted">Checking…</span>
                            ) : null}
                            {balanceView?.status === 'observed' ? (
                              <>
                                <span className="mono">{balanceView.ether} ETH</span>{' '}
                                {(() => {
                                  const chip = dash.balancePolicyChip(
                                    balanceView.wei,
                                    wallet.policy?.minimumBalanceWei,
                                  );
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
                            <span className={dash.enabledBadge(wallet.enabled)}>
                              {wallet.enabled ? 'enabled' : 'disabled'}
                            </span>
                          </td>
                          <td>
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
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
