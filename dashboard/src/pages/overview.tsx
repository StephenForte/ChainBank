import type { AlertResource, ManagedWalletResource, ReconciliationRunResource } from '../api';
import { matchesChainFilter, type VisibleChainIds } from '../chain-filter';
import {
  formatTimestamp,
  runCompletionLabel,
  walletNeedsAttention,
  type LoadState,
  type WalletBalanceView,
} from '../dashboard-shared';
import { IconAlerts, IconReconciliation, IconTreasuries, IconWallets } from '../icons';
import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { StatCard } from '../primitives';
import { TreasuriesPanel, type TreasuriesPanelProps } from './panels/treasuries-panel';

export type OverviewPageProps = {
  readonly treasuries: TreasuriesPanelProps;
  readonly wallets: readonly ManagedWalletResource[];
  readonly walletsState: LoadState;
  readonly walletBalances: Readonly<Record<string, WalletBalanceView>>;
  readonly openFindingAlerts: readonly AlertResource[];
  readonly findingAlertsState: LoadState;
  readonly reconciliationRuns: readonly ReconciliationRunResource[];
  readonly reconciliationState: LoadState;
  readonly visibleChainIds: VisibleChainIds;
};

function countLoaded(state: LoadState): boolean {
  return state === 'ready' || state === 'empty';
}

export function OverviewPage({
  treasuries,
  wallets,
  walletsState,
  walletBalances,
  openFindingAlerts,
  findingAlertsState,
  reconciliationRuns,
  reconciliationState,
  visibleChainIds,
}: OverviewPageProps) {
  const visibleTreasuries = treasuries.treasuries.filter((treasury) =>
    matchesChainFilter(treasury, visibleChainIds),
  );
  let healthy = 0;
  let warning = 0;
  let critical = 0;
  for (const treasury of visibleTreasuries) {
    if (treasury.status === 'healthy') {
      healthy += 1;
    } else if (treasury.status === 'warning') {
      warning += 1;
    } else if (treasury.status === 'critical') {
      critical += 1;
    }
  }
  const treasuryValue = countLoaded(treasuries.treasuriesState)
    ? `${String(healthy)} healthy · ${String(warning)} warning · ${String(critical)} critical`
    : '—';

  const visibleWallets = wallets.filter((wallet) => matchesChainFilter(wallet, visibleChainIds));
  const attentionCount = visibleWallets.filter((wallet) =>
    walletNeedsAttention(wallet, walletBalances[wallet.id]),
  ).length;
  const walletsValue = countLoaded(walletsState) ? String(attentionCount) : '—';

  const alertsValue = countLoaded(findingAlertsState) ? String(openFindingAlerts.length) : '—';

  const newestRun = reconciliationRuns[0];
  const runValue =
    countLoaded(reconciliationState) && newestRun !== undefined ? runCompletionLabel(newestRun).label : '—';
  const runHint =
    newestRun !== undefined
      ? newestRun.finishedAt === null
        ? 'Not finished'
        : formatTimestamp(newestRun.finishedAt)
      : countLoaded(reconciliationState)
        ? 'No runs yet'
        : undefined;

  return (
    <>
      <div className="stat-row">
        <StatCard
          label="Treasury health"
          value={treasuryValue}
          href="#/treasuries"
          icon={<IconTreasuries />}
        />
        <StatCard
          label="Wallets needing attention"
          value={walletsValue}
          href="#/wallets"
          icon={<IconWallets />}
        />
        <StatCard
          label="Open alerts"
          value={alertsValue}
          href="#/alerts"
          icon={<IconAlerts />}
          {...(countLoaded(findingAlertsState) && openFindingAlerts.length > 0
            ? { badge: 'all chains' }
            : {})}
        />
        <StatCard
          label="Last reconciler run"
          value={runValue}
          href="#/reconciliation"
          icon={<IconReconciliation />}
          {...(runHint !== undefined ? { hint: runHint } : {})}
        />
      </div>
      <PanelErrorBoundary panelName="Treasuries" severity="alarm">
        <PanelBody
          render={() => (
            <TreasuriesPanel {...treasuries} visibleChainIds={visibleChainIds} presentation="compact" />
          )}
        />
      </PanelErrorBoundary>
    </>
  );
}
