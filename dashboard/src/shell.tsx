import type { FormEvent, ReactNode } from 'react';
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
import { SessionPanel } from './pages/panels/session-panel';
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
  readonly tokenInput: string;
  readonly setTokenInput: (value: string) => void;
  readonly sessionBusy: boolean;
  readonly onSaveToken: (event: FormEvent) => void;
};

export function Sidebar({ route, tokenInput, setTokenInput, sessionBusy, onSaveToken }: SidebarProps) {
  return (
    <aside className="sidebar">
      <p className="sidebar-brand">ChainBank</p>
      <nav className="sidebar-nav" aria-label="Pages">
        <ul>
          {NAV_ITEMS.map((item) => {
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
              <SessionPanel
                tokenInput={tokenInput}
                setTokenInput={setTokenInput}
                sessionBusy={sessionBusy}
                onSaveToken={onSaveToken}
              />
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
  readonly token: string;
  readonly onRefresh: () => void;
  readonly onTestEmail: () => Promise<void>;
  readonly sessionError: string | undefined;
};

export function TopBar({ title, sessionBusy, token, onRefresh, onTestEmail, sessionError }: TopBarProps) {
  return (
    <header className="top-bar">
      <h1 className="page-title">{title}</h1>
      <div className="top-bar-actions">
        <button type="button" className="secondary" disabled={sessionBusy} onClick={onRefresh}>
          Refresh
        </button>
        <button
          type="button"
          className="secondary"
          disabled={sessionBusy || token === ''}
          onClick={() => {
            void onTestEmail();
          }}
        >
          Test email
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
  readonly tokenInput: string;
  readonly setTokenInput: (value: string) => void;
  readonly sessionBusy: boolean;
  readonly onSaveToken: (event: FormEvent) => void;
  readonly sessionError: string | undefined;
  readonly token: string;
  readonly onRefresh: () => void;
  readonly onTestEmail: () => Promise<void>;
  /**
   * Open treasury-finding alerts already loaded by App. Shown on pages that do
   * not mount the reconciliation panel, so a critical is not page-gated (C20).
   */
  readonly openFindingAlertCount: number;
  readonly findingAlertsError: string | undefined;
  readonly findingAlertsFailed: boolean;
  readonly children: ReactNode;
};

export function Shell({
  route,
  tokenInput,
  setTokenInput,
  sessionBusy,
  onSaveToken,
  sessionError,
  token,
  onRefresh,
  onTestEmail,
  openFindingAlertCount,
  findingAlertsError,
  findingAlertsFailed,
  children,
}: ShellProps) {
  const showsFindings = route === 'reconciliation' || route === 'alerts';
  const criticalLabel =
    openFindingAlertCount === 1
      ? '1 unacknowledged critical finding'
      : `${String(openFindingAlertCount)} unacknowledged critical findings`;

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        tokenInput={tokenInput}
        setTokenInput={setTokenInput}
        sessionBusy={sessionBusy}
        onSaveToken={onSaveToken}
      />
      <div className="shell-main">
        <TopBar
          title={PAGE_TITLES[route]}
          sessionBusy={sessionBusy}
          token={token}
          onRefresh={onRefresh}
          onTestEmail={onTestEmail}
          sessionError={sessionError}
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
