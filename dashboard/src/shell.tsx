import type { ReactNode } from 'react';
import {
  ChainFilterControl,
  type ChainSegment,
  type ChainSegmentAttention,
  type ChainFilterSelection,
} from './chain-filter';
import {
  IconAdmin,
  IconAlerts,
  IconEmail,
  IconFunding,
  IconOverview,
  IconReconciliation,
  IconTreasuries,
  IconWallets,
} from './icons';
import { PanelBody, PanelErrorBoundary } from './panel-error-boundary';
import { ChangePasswordForm } from './session/change-password-form';
import type { SessionUser } from './session/use-session';
import type { DashboardRoute } from './use-hash-route';

export const PAGE_TITLES: Record<DashboardRoute, string> = {
  overview: 'Overview',
  treasuries: 'Treasuries',
  wallets: 'Wallets',
  funding: 'Funding',
  reconciliation: 'Reconciliation',
  alerts: 'Alerts',
  email: 'Email',
  admin: 'Admin',
};

const NAV_ITEMS: readonly {
  readonly id: DashboardRoute;
  readonly label: string;
  readonly Icon: () => ReactNode;
}[] = [
  { id: 'overview', label: 'Overview', Icon: IconOverview },
  { id: 'treasuries', label: 'Treasuries', Icon: IconTreasuries },
  { id: 'wallets', label: 'Wallets', Icon: IconWallets },
  { id: 'funding', label: 'Funding', Icon: IconFunding },
  { id: 'reconciliation', label: 'Reconciliation', Icon: IconReconciliation },
  { id: 'alerts', label: 'Alerts', Icon: IconAlerts },
  { id: 'email', label: 'Email', Icon: IconEmail },
  { id: 'admin', label: 'Admin', Icon: IconAdmin },
];

export type SidebarProps = {
  readonly route: DashboardRoute;
  readonly user: SessionUser;
  readonly sessionBusy: boolean;
  readonly onLogout: () => Promise<void>;
};

export function Sidebar({ route, user, sessionBusy, onLogout }: SidebarProps) {
  const items = NAV_ITEMS.filter((item) => item.id !== 'admin' || user.role === 'admin');
  return (
    <aside className="sidebar">
      <p className="sidebar-brand">ChainBank</p>
      <nav className="sidebar-nav" aria-label="Pages">
        <ul>
          {items.map((item) => {
            const Icon = item.Icon;
            return (
              <li key={item.id}>
                <a
                  className="nav-link"
                  href={`#/${item.id}`}
                  aria-current={route === item.id ? 'page' : undefined}
                >
                  <Icon />
                  <span>{item.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="sidebar-user">
        <PanelErrorBoundary panelName="Session" severity="elevated">
          <PanelBody
            render={() => (
              <div className="user-block">
                <p className="user-name">{user.displayName}</p>
                <p className="user-role">{user.role}</p>
                {user.role === 'admin' ? null : (
                  <details className="account-menu">
                    <summary>Account</summary>
                    <ChangePasswordForm />
                  </details>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={sessionBusy}
                  onClick={() => {
                    void onLogout();
                  }}
                >
                  Log out
                </button>
              </div>
            )}
          />
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

export type TopBarProps = {
  readonly title: string;
  readonly sessionBusy: boolean;
  readonly onRefresh: () => void;
  readonly sessionError: string | undefined;
  readonly chainSegments: readonly ChainSegment[];
  readonly chainSelection: ChainFilterSelection;
  readonly chainAttention: readonly ChainSegmentAttention[];
  readonly onSelectChain: (next: ChainFilterSelection) => void;
};

export function TopBar({
  title,
  sessionBusy,
  onRefresh,
  sessionError,
  chainSegments,
  chainSelection,
  chainAttention,
  onSelectChain,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <h1 className="page-title">{title}</h1>
      <ChainFilterControl
        segments={chainSegments}
        selection={chainSelection}
        attention={chainAttention}
        onSelect={onSelectChain}
      />
      <div className="top-bar-actions">
        <button type="button" className="secondary" disabled={sessionBusy} onClick={onRefresh}>
          Refresh
        </button>
        {sessionError !== undefined ? <p className="error-inline">{sessionError}</p> : null}
      </div>
    </header>
  );
}

export function Page(props: { readonly children: ReactNode }) {
  return <div className="page-stack">{props.children}</div>;
}

export type ShellProps = {
  readonly route: DashboardRoute;
  readonly user: SessionUser;
  readonly sessionBusy: boolean;
  readonly onLogout: () => Promise<void>;
  readonly sessionError: string | undefined;
  readonly onRefresh: () => void;
  /**
   * Open treasury-finding alerts already loaded by App. Shown on pages that do
   * not mount the reconciliation panel, so a critical is not page-gated (C20).
   */
  readonly openFindingAlertCount: number;
  readonly findingAlertsError: string | undefined;
  readonly findingAlertsFailed: boolean;
  readonly chainSegments: readonly ChainSegment[];
  readonly chainSelection: ChainFilterSelection;
  readonly chainAttention: readonly ChainSegmentAttention[];
  readonly onSelectChain: (next: ChainFilterSelection) => void;
  readonly children: ReactNode;
};

export function Shell({
  route,
  user,
  sessionBusy,
  onLogout,
  sessionError,
  onRefresh,
  openFindingAlertCount,
  findingAlertsError,
  findingAlertsFailed,
  chainSegments,
  chainSelection,
  chainAttention,
  onSelectChain,
  children,
}: ShellProps) {
  const showsFindings = route === 'reconciliation' || route === 'alerts';
  const criticalLabel =
    openFindingAlertCount === 1
      ? '1 unacknowledged critical finding'
      : `${String(openFindingAlertCount)} unacknowledged critical findings`;

  return (
    <div className="app-shell">
      <Sidebar route={route} user={user} sessionBusy={sessionBusy} onLogout={onLogout} />
      <div className="shell-main">
        <TopBar
          title={PAGE_TITLES[route]}
          sessionBusy={sessionBusy}
          onRefresh={onRefresh}
          sessionError={sessionError}
          chainSegments={chainSegments}
          chainSelection={chainSelection}
          chainAttention={chainAttention}
          onSelectChain={onSelectChain}
        />
        {!showsFindings && openFindingAlertCount > 0 ? (
          <div className="shell-critical" role="alert">
            <p>{criticalLabel}</p>
            <a href="#/alerts">Review findings</a>
          </div>
        ) : null}
        {!showsFindings && findingAlertsFailed ? (
          <div className="shell-critical" role="alert">
            <p>Finding alerts could not be loaded. {findingAlertsError ?? ''}</p>
            <a href="#/reconciliation">Open reconciliation</a>
          </div>
        ) : null}
        <main className="page-body">
          <Page>{children}</Page>
        </main>
      </div>
    </div>
  );
}
