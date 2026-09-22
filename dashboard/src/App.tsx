import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  acknowledgeAlert,
  acknowledgeFinding,
  checkTreasury,
  fetchReadiness,
  getEnvironment,
  getWalletBalance,
  listAlerts,
  listFundingTransactions,
  listProjectEnvironments,
  listProjects,
  listReconciliationRuns,
  listTreasuries,
  listWallets,
  sendTestEmail,
  setEnvironmentEnabled,
  setProjectEnabled,
  setWalletEnabled,
  setWalletPolicy,
  setWalletReconciliationEnabled,
  type AlertResource,
  type EnvironmentResource,
  type FundingTransactionResource,
  type ManagedWalletResource,
  type ProjectResource,
  type ReadinessResponse,
  type ReconciliationRunResource,
  type TreasuryResource,
} from './api';
import {
  formatError,
  formatWeiAsEther,
  fundingHistoryOperationType,
  loadAcknowledgedFindingsExpanded,
  loadReconciliationDetailExpanded,
  loadStoredToken,
  parseEtherInputToWei,
  shortAddress,
  storeAcknowledgedFindingsExpanded,
  storeReconciliationDetailExpanded,
  storeToken,
  BALANCE_AUTO_LOAD_MAX,
  type FindingView,
  type LoadState,
  type WalletBalanceView,
} from './dashboard-shared';
import { AdminPage } from './pages/admin';
import { AlertsPage } from './pages/alerts';
import { EmailPage } from './pages/email';
import { FundingPage } from './pages/funding';
import { OverviewPage } from './pages/overview';
import type { EnvironmentsPanelProps } from './pages/panels/environments-panel';
import type { FundingHistoryPanelProps } from './pages/panels/funding-history-panel';
import type { FundingPolicyPanelProps } from './pages/panels/funding-policy-panel';
import type { ManagedWalletsPanelProps } from './pages/panels/managed-wallets-panel';
import type { ProjectsPanelProps } from './pages/panels/projects-panel';
import type { ReconciliationPanelProps } from './pages/panels/reconciliation-panel';
import type { ServiceReadinessPanelProps } from './pages/panels/service-readiness-panel';
import type { TreasuriesPanelProps } from './pages/panels/treasuries-panel';
import { ReconciliationPage } from './pages/reconciliation';
import { TreasuriesPage } from './pages/treasuries';
import { WalletsPage } from './pages/wallets';
import { Shell } from './shell';
import { useHashRoute } from './use-hash-route';

export function App() {
  const [tokenInput, setTokenInput] = useState(loadStoredToken);
  const [token, setToken] = useState(loadStoredToken);
  const [message, setMessage] = useState<string | undefined>();
  const [sessionError, setSessionError] = useState<string | undefined>();
  const [sessionBusy, setSessionBusy] = useState(false);

  const [readiness, setReadiness] = useState<ReadinessResponse | undefined>();
  const [readinessState, setReadinessState] = useState<LoadState>('idle');
  const [readinessError, setReadinessError] = useState<string | undefined>();

  const [treasuries, setTreasuries] = useState<readonly TreasuryResource[]>([]);
  const [treasuriesState, setTreasuriesState] = useState<LoadState>('idle');
  const [treasuriesError, setTreasuriesError] = useState<string | undefined>();
  const [treasuryBusyId, setTreasuryBusyId] = useState<string | undefined>();

  const [fundingHistory, setFundingHistory] = useState<readonly FundingTransactionResource[]>([]);
  const [fundingHistoryTotal, setFundingHistoryTotal] = useState(0);
  const [fundingHistoryState, setFundingHistoryState] = useState<LoadState>('idle');
  const [fundingHistoryError, setFundingHistoryError] = useState<string | undefined>();
  const [historyProjectFilter, setHistoryProjectFilter] = useState('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState('');
  const [historyKindFilter, setHistoryKindFilter] = useState('');
  const [treasuryFundingHistory, setTreasuryFundingHistory] = useState<readonly FundingTransactionResource[]>(
    [],
  );
  const [treasuryFundingHistoryState, setTreasuryFundingHistoryState] = useState<LoadState>('idle');
  const [treasuryFundingHistoryError, setTreasuryFundingHistoryError] = useState<string | undefined>();

  const [reconciliationRuns, setReconciliationRuns] = useState<readonly ReconciliationRunResource[]>([]);
  const [reconciliationRunsTotal, setReconciliationRunsTotal] = useState(0);
  const [reconciliationState, setReconciliationState] = useState<LoadState>('idle');
  const [reconciliationError, setReconciliationError] = useState<string | undefined>();
  // Persists warnings + run-history visibility only — unacknowledged criticals are never gated on this.
  const [reconciliationDetailExpanded, setReconciliationDetailExpanded] = useState(
    loadReconciliationDetailExpanded,
  );
  const [acknowledgedFindingsExpanded, setAcknowledgedFindingsExpanded] = useState(
    loadAcknowledgedFindingsExpanded,
  );

  // C20 — standing incident record from GET /v1/alerts (not the runs page window).
  const [openFindingAlerts, setOpenFindingAlerts] = useState<readonly AlertResource[]>([]);
  const [acknowledgedFindingAlerts, setAcknowledgedFindingAlerts] = useState<readonly AlertResource[]>([]);
  // False until a fetch proves open.total <= fetched length — see isCriticalFindingAcknowledged.
  const [openFindingAlertsComplete, setOpenFindingAlertsComplete] = useState(false);
  const [findingAlertsState, setFindingAlertsState] = useState<LoadState>('idle');
  const [findingAlertsError, setFindingAlertsError] = useState<string | undefined>();
  const [ackDraftByAlertId, setAckDraftByAlertId] = useState<Readonly<Record<string, string>>>({});
  const [ackErrorByAlertId, setAckErrorByAlertId] = useState<Readonly<Record<string, string>>>({});
  const [ackBusyId, setAckBusyId] = useState<string | undefined>();
  /** Entity-id keyed drafts for always-visible critical findings (C20 finding path). */
  const [ackDraftByEntityId, setAckDraftByEntityId] = useState<Readonly<Record<string, string>>>({});
  const [ackErrorByEntityId, setAckErrorByEntityId] = useState<Readonly<Record<string, string>>>({});
  const [ackBusyEntityId, setAckBusyEntityId] = useState<string | undefined>();
  /** Expanded detail for compact always-visible criticals — presence is never gated on this. */
  const [expandedCriticalEntityIds, setExpandedCriticalEntityIds] = useState<
    Readonly<Record<string, boolean>>
  >({});

  const [projects, setProjects] = useState<readonly ProjectResource[]>([]);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [projectsState, setProjectsState] = useState<LoadState>('idle');
  const [projectsError, setProjectsError] = useState<string | undefined>();
  const [projectBusyId, setProjectBusyId] = useState<string | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState('');

  const [envLookupId, setEnvLookupId] = useState('');
  const [projectEnvironments, setProjectEnvironments] = useState<readonly EnvironmentResource[]>([]);
  const [envListState, setEnvListState] = useState<LoadState>('idle');
  const [envListError, setEnvListError] = useState<string | undefined>();
  const [environmentDetail, setEnvironmentDetail] = useState<EnvironmentResource | undefined>();
  const [environmentState, setEnvironmentState] = useState<LoadState>('idle');
  const [environmentError, setEnvironmentError] = useState<string | undefined>();
  const [environmentBusy, setEnvironmentBusy] = useState(false);

  const [wallets, setWallets] = useState<readonly ManagedWalletResource[]>([]);
  const [walletsTotal, setWalletsTotal] = useState(0);
  const [walletsState, setWalletsState] = useState<LoadState>('idle');
  const [walletsError, setWalletsError] = useState<string | undefined>();
  const [walletBusyId, setWalletBusyId] = useState<string | undefined>();
  const [walletProjectFilter, setWalletProjectFilter] = useState('');
  const [walletEnvironmentFilter, setWalletEnvironmentFilter] = useState('');
  const [walletEnabledFilter, setWalletEnabledFilter] = useState('');
  const [walletBalances, setWalletBalances] = useState<Readonly<Record<string, WalletBalanceView>>>({});
  const [balancesBusy, setBalancesBusy] = useState(false);
  /** Bumped to supersede in-flight balance reads when the listed set changes (TX.18). */
  const balanceFetchGenerationRef = useRef(0);
  const route = useHashRoute();

  const [policyWallets, setPolicyWallets] = useState<readonly ManagedWalletResource[]>([]);
  const [policyWalletsTotal, setPolicyWalletsTotal] = useState(0);
  const [policyState, setPolicyState] = useState<LoadState>('idle');
  const [policyError, setPolicyError] = useState<string | undefined>();
  const [policyBusyId, setPolicyBusyId] = useState<string | undefined>();
  const [editingWalletId, setEditingWalletId] = useState<string | undefined>();
  const [minimumEtherInput, setMinimumEtherInput] = useState('');
  const [targetEtherInput, setTargetEtherInput] = useState('');
  const [maximumEtherInput, setMaximumEtherInput] = useState('');
  const [policyPreviewError, setPolicyPreviewError] = useState<string | undefined>();

  async function loadReadiness(): Promise<void> {
    setReadinessState('loading');
    setReadinessError(undefined);
    try {
      const next = await fetchReadiness();
      setReadiness(next);
      setReadinessState('ready');
    } catch (caught) {
      setReadiness(undefined);
      setReadinessError(formatError(caught));
      setReadinessState('error');
    }
  }

  async function loadTreasuries(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setTreasuries([]);
      setTreasuriesState('idle');
      setTreasuriesError(undefined);
      return;
    }
    setTreasuriesState('loading');
    setTreasuriesError(undefined);
    try {
      const next = await listTreasuries(activeToken.trim());
      setTreasuries(next);
      setTreasuriesState(next.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setTreasuries([]);
      setTreasuriesError(formatError(caught));
      setTreasuriesState('error');
    }
  }

  async function loadFundingHistory(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setFundingHistory([]);
      setFundingHistoryTotal(0);
      setFundingHistoryState('idle');
      setFundingHistoryError(undefined);
      return;
    }
    setFundingHistoryState('loading');
    setFundingHistoryError(undefined);
    try {
      // Omit absent filters — exactOptionalPropertyTypes rejects `prop: undefined`.
      const operationType = fundingHistoryOperationType(historyKindFilter);
      const next = await listFundingTransactions(activeToken.trim(), {
        ...(historyProjectFilter.trim() === '' ? {} : { projectId: historyProjectFilter.trim() }),
        ...(historyStatusFilter === '' ? {} : { status: historyStatusFilter }),
        ...(operationType === undefined ? {} : { operationType }),
        limit: 50,
      });
      setFundingHistory(next.data);
      setFundingHistoryTotal(next.pagination.total);
      setFundingHistoryState(next.data.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setFundingHistory([]);
      setFundingHistoryTotal(0);
      setFundingHistoryError(formatError(caught));
      setFundingHistoryState('error');
    }
  }

  async function loadTreasuryFundingHistory(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setTreasuryFundingHistory([]);
      setTreasuryFundingHistoryState('idle');
      setTreasuryFundingHistoryError(undefined);
      return;
    }
    setTreasuryFundingHistoryState('loading');
    setTreasuryFundingHistoryError(undefined);
    try {
      const next = await listFundingTransactions(activeToken.trim(), {
        operationType: 'replenish_operational',
        limit: 50,
      });
      setTreasuryFundingHistory(next.data);
      setTreasuryFundingHistoryState(next.data.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setTreasuryFundingHistory([]);
      setTreasuryFundingHistoryError(formatError(caught));
      setTreasuryFundingHistoryState('error');
    }
  }

  async function loadReconciliationRuns(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setReconciliationRuns([]);
      setReconciliationRunsTotal(0);
      setReconciliationState('idle');
      setReconciliationError(undefined);
      return;
    }
    setReconciliationState('loading');
    setReconciliationError(undefined);
    try {
      // Plain DB read — no RPC cost; load with the other panels (unlike C17 balances).
      const next = await listReconciliationRuns(activeToken.trim(), { limit: 50, offset: 0 });
      setReconciliationRuns(next.data);
      setReconciliationRunsTotal(next.pagination.total);
      setReconciliationState(next.data.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setReconciliationRuns([]);
      setReconciliationRunsTotal(0);
      setReconciliationError(formatError(caught));
      setReconciliationState('error');
    }
  }

  async function loadFindingAlerts(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setOpenFindingAlerts([]);
      setAcknowledgedFindingAlerts([]);
      setOpenFindingAlertsComplete(false);
      setFindingAlertsState('idle');
      setFindingAlertsError(undefined);
      return;
    }
    setFindingAlertsState('loading');
    // While loading, refuse demotion even if a prior page looked complete.
    setOpenFindingAlertsComplete(false);
    setFindingAlertsError(undefined);
    try {
      const trimmed = activeToken.trim();
      // Two filtered pages — standing banner must not depend on the runs window (C20).
      const [openPage, acknowledgedPage] = await Promise.all([
        listAlerts(trimmed, {
          alertType: 'treasury_finding',
          state: 'open',
          limit: 50,
          offset: 0,
        }),
        listAlerts(trimmed, {
          alertType: 'treasury_finding',
          state: 'acknowledged',
          limit: 50,
          offset: 0,
        }),
      ]);
      setOpenFindingAlerts(openPage.data);
      setAcknowledgedFindingAlerts(acknowledgedPage.data);
      // Demotion needs to prove no open row exists; a truncated open page cannot.
      setOpenFindingAlertsComplete(openPage.pagination.total <= openPage.data.length);
      setFindingAlertsState(
        openPage.data.length === 0 && acknowledgedPage.data.length === 0 ? 'empty' : 'ready',
      );
    } catch (caught) {
      setOpenFindingAlerts([]);
      setAcknowledgedFindingAlerts([]);
      setOpenFindingAlertsComplete(false);
      setFindingAlertsError(formatError(caught));
      setFindingAlertsState('error');
    }
  }

  async function onAcknowledgeFinding(alertId: string): Promise<void> {
    const note = (ackDraftByAlertId[alertId] ?? '').trim();
    if (note === '') {
      setAckErrorByAlertId((prev) => ({ ...prev, [alertId]: 'Acknowledgement note is required.' }));
      return;
    }
    if (token.trim() === '') {
      return;
    }
    setAckBusyId(alertId);
    setAckErrorByAlertId((prev) => {
      const next = { ...prev };
      delete next[alertId];
      return next;
    });
    try {
      await acknowledgeAlert(token.trim(), alertId, note);
      setAckDraftByAlertId((prev) => {
        const next = { ...prev };
        delete next[alertId];
        return next;
      });
      setMessage('Finding alert acknowledged. The incident record stays visible.');
      await loadFindingAlerts(token);
    } catch (caught) {
      setAckErrorByAlertId((prev) => ({ ...prev, [alertId]: formatError(caught) }));
    } finally {
      setAckBusyId(undefined);
    }
  }

  async function onAcknowledgeFindingByEntity(finding: FindingView, entityId: string): Promise<void> {
    const note = (ackDraftByEntityId[entityId] ?? '').trim();
    if (note === '') {
      setAckErrorByEntityId((prev) => ({
        ...prev,
        [entityId]: 'Acknowledgement note is required.',
      }));
      return;
    }
    if (token.trim() === '') {
      return;
    }
    setAckBusyEntityId(entityId);
    setAckErrorByEntityId((prev) => {
      const next = { ...prev };
      delete next[entityId];
      return next;
    });
    try {
      await acknowledgeFinding(token.trim(), {
        entityId,
        note,
        metadata: {
          findingKind: finding.kind,
          ...(finding.treasuryId !== undefined ? { treasuryId: finding.treasuryId } : {}),
          ...(finding.transactionHash !== undefined ? { transactionHash: finding.transactionHash } : {}),
          ...(finding.toAddress !== undefined ? { toAddress: finding.toAddress } : {}),
          ...(finding.valueWei !== undefined ? { valueWei: finding.valueWei } : {}),
          ...(finding.nonce !== undefined ? { nonce: finding.nonce } : {}),
          ...(finding.blockNumber !== undefined ? { blockNumber: finding.blockNumber } : {}),
          ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
          runId: finding.runId,
        },
      });
      setAckDraftByEntityId((prev) => {
        const next = { ...prev };
        delete next[entityId];
        return next;
      });
      setMessage('Finding acknowledged. The incident record stays visible.');
      await loadFindingAlerts(token);
    } catch (caught) {
      setAckErrorByEntityId((prev) => ({ ...prev, [entityId]: formatError(caught) }));
    } finally {
      setAckBusyEntityId(undefined);
    }
  }

  async function loadProjectsPanel(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setProjects([]);
      setProjectsTotal(0);
      setProjectsState('idle');
      setProjectsError(undefined);
      return;
    }
    setProjectsState('loading');
    setProjectsError(undefined);
    try {
      const next = await listProjects(activeToken.trim(), { limit: 50, offset: 0 });
      setProjects(next.data);
      setProjectsTotal(next.pagination.total);
      setProjectsState(next.data.length === 0 ? 'empty' : 'ready');
      if (selectedProjectId === '' && next.data.length > 0) {
        // Prefer the first enabled project: a disabled one (e.g. a retired smoke
        // test that happens to be oldest) must not scope the policy panel by default.
        const defaultProject = next.data.find((project) => project.enabled) ?? next.data[0];
        setSelectedProjectId(defaultProject?.id ?? '');
      }
    } catch (caught) {
      setProjects([]);
      setProjectsTotal(0);
      setProjectsError(formatError(caught));
      setProjectsState('error');
    }
  }

  async function loadProjectEnvironments(activeToken: string, projectId: string): Promise<void> {
    if (activeToken.trim() === '' || projectId.trim() === '') {
      setProjectEnvironments([]);
      setEnvListState('idle');
      setEnvListError(undefined);
      return;
    }
    setEnvListState('loading');
    setEnvListError(undefined);
    try {
      const page = await listProjectEnvironments(activeToken.trim(), projectId.trim(), {
        limit: 100,
        offset: 0,
      });
      setProjectEnvironments(page.data);
      setEnvListState(page.data.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setProjectEnvironments([]);
      setEnvListError(formatError(caught));
      setEnvListState('error');
    }
  }

  async function loadEnvironmentDetail(activeToken: string, environmentId: string): Promise<void> {
    if (activeToken.trim() === '' || environmentId.trim() === '') {
      setEnvironmentDetail(undefined);
      setEnvironmentState('idle');
      setEnvironmentError(undefined);
      return;
    }
    setEnvironmentState('loading');
    setEnvironmentError(undefined);
    try {
      const next = await getEnvironment(activeToken.trim(), environmentId.trim());
      setEnvironmentDetail(next);
      setEnvironmentState('ready');
      setEnvLookupId(next.id);
    } catch (caught) {
      setEnvironmentDetail(undefined);
      setEnvironmentError(formatError(caught));
      setEnvironmentState('error');
    }
  }

  async function loadWalletsPanel(activeToken: string): Promise<void> {
    // Supersede any in-flight balance burst before the list (and its filters) change.
    const generation = ++balanceFetchGenerationRef.current;
    if (activeToken.trim() === '') {
      setWallets([]);
      setWalletsTotal(0);
      setWalletsState('idle');
      setWalletsError(undefined);
      setWalletBalances({});
      setBalancesBusy(false);
      return;
    }
    setWalletsState('loading');
    setWalletsError(undefined);
    try {
      // Omit absent filters — exactOptionalPropertyTypes rejects `prop: undefined`.
      const next = await listWallets(activeToken.trim(), {
        ...(walletProjectFilter.trim() === '' ? {} : { projectId: walletProjectFilter.trim() }),
        ...(walletEnvironmentFilter.trim() === '' ? {} : { environmentId: walletEnvironmentFilter.trim() }),
        ...(walletEnabledFilter === 'true'
          ? { enabled: true }
          : walletEnabledFilter === 'false'
            ? { enabled: false }
            : {}),
        limit: 50,
        offset: 0,
      });
      if (generation !== balanceFetchGenerationRef.current) {
        return;
      }
      setWallets(next.data);
      setWalletsTotal(next.pagination.total);
      setWalletsState(next.data.length === 0 ? 'empty' : 'ready');
      // List reload invalidates prior point-in-time samples.
      setWalletBalances({});
      // Auto-load only for small listed pages — above the guard, button-only (C17 / TX.18).
      if (next.data.length > 0 && next.data.length <= BALANCE_AUTO_LOAD_MAX) {
        void fetchListedWalletBalances(activeToken, next.data, generation);
      } else {
        setBalancesBusy(false);
      }
    } catch (caught) {
      if (generation !== balanceFetchGenerationRef.current) {
        return;
      }
      setWallets([]);
      setWalletsTotal(0);
      setWalletsError(formatError(caught));
      setWalletsState('error');
      setWalletBalances({});
      setBalancesBusy(false);
    }
  }

  async function fetchOneWalletBalance(
    activeToken: string,
    walletId: string,
    generation: number = balanceFetchGenerationRef.current,
  ): Promise<void> {
    if (generation !== balanceFetchGenerationRef.current) {
      return;
    }
    setWalletBalances((previous) => ({ ...previous, [walletId]: { status: 'loading' } }));
    try {
      const result = await getWalletBalance(activeToken.trim(), walletId);
      if (generation !== balanceFetchGenerationRef.current) {
        return;
      }
      const balance = result.balance;
      if (balance.outcome === 'observed') {
        const observed: WalletBalanceView = {
          status: 'observed',
          wei: balance.wei,
          ether: balance.ether,
          observedAt: balance.observedAt,
        };
        setWalletBalances((previous) => ({ ...previous, [walletId]: observed }));
        return;
      }
      // Fail closed: never invent a zero balance from an unreadable RPC (C17).
      const unavailable: WalletBalanceView = {
        status: 'unavailable',
        errorCode: balance.errorCode,
        observedAt: balance.observedAt,
      };
      setWalletBalances((previous) => ({ ...previous, [walletId]: unavailable }));
    } catch (caught) {
      if (generation !== balanceFetchGenerationRef.current) {
        return;
      }
      const failed: WalletBalanceView = { status: 'error', message: formatError(caught) };
      setWalletBalances((previous) => ({ ...previous, [walletId]: failed }));
    }
  }

  async function fetchListedWalletBalances(
    activeToken: string,
    listed: readonly ManagedWalletResource[],
    generation: number,
  ): Promise<void> {
    if (activeToken.trim() === '' || listed.length === 0) {
      return;
    }
    if (generation !== balanceFetchGenerationRef.current) {
      return;
    }
    setBalancesBusy(true);
    try {
      // Fan out one live RPC-backed request per currently listed wallet only.
      await Promise.all(listed.map((wallet) => fetchOneWalletBalance(activeToken, wallet.id, generation)));
    } finally {
      if (generation === balanceFetchGenerationRef.current) {
        setBalancesBusy(false);
      }
    }
  }

  async function checkListedWalletBalances(activeToken: string): Promise<void> {
    if (activeToken.trim() === '' || wallets.length === 0) {
      return;
    }
    const generation = ++balanceFetchGenerationRef.current;
    await fetchListedWalletBalances(activeToken, wallets, generation);
  }

  function onToggleAcknowledgedFindings(): void {
    setAcknowledgedFindingsExpanded((previous) => {
      const next = !previous;
      storeAcknowledgedFindingsExpanded(next);
      return next;
    });
  }

  function onToggleReconciliationDetail(): void {
    setReconciliationDetailExpanded((previous) => {
      const next = !previous;
      storeReconciliationDetailExpanded(next);
      return next;
    });
  }

  async function loadPolicyPanel(activeToken: string): Promise<void> {
    if (activeToken.trim() === '') {
      setPolicyWallets([]);
      setPolicyWalletsTotal(0);
      setPolicyState('idle');
      setPolicyError(undefined);
      return;
    }
    setPolicyState('loading');
    setPolicyError(undefined);
    try {
      // Omit absent filters — exactOptionalPropertyTypes rejects `prop: undefined`.
      const next = await listWallets(activeToken.trim(), {
        ...(selectedProjectId.trim() === '' ? {} : { projectId: selectedProjectId.trim() }),
        limit: 50,
        offset: 0,
      });
      setPolicyWallets(next.data);
      setPolicyWalletsTotal(next.pagination.total);
      setPolicyState(next.data.length === 0 ? 'empty' : 'ready');
    } catch (caught) {
      setPolicyWallets([]);
      setPolicyWalletsTotal(0);
      setPolicyError(formatError(caught));
      setPolicyState('error');
    }
  }

  function refreshAll(activeToken: string): void {
    // Each panel loads and fails independently — do not Promise.all across panels.
    void loadReadiness();
    void loadTreasuries(activeToken);
    void loadTreasuryFundingHistory(activeToken);
    void loadReconciliationRuns(activeToken);
    void loadFindingAlerts(activeToken);
    void loadFundingHistory(activeToken);
    void loadProjectsPanel(activeToken);
    void loadWalletsPanel(activeToken);
    void loadPolicyPanel(activeToken);
    if (selectedProjectId.trim() !== '') {
      void loadProjectEnvironments(activeToken, selectedProjectId);
    }
    if (envLookupId.trim() !== '') {
      void loadEnvironmentDetail(activeToken, envLookupId);
    }
  }

  useEffect(() => {
    void loadReadiness();
  }, []);

  useEffect(() => {
    void loadTreasuries(token);
    void loadTreasuryFundingHistory(token);
    void loadProjectsPanel(token);
    void loadReconciliationRuns(token);
    void loadFindingAlerts(token);
  }, [token]);

  useEffect(() => {
    void loadFundingHistory(token);
  }, [token, historyProjectFilter, historyStatusFilter, historyKindFilter]);

  useEffect(() => {
    void loadWalletsPanel(token);
  }, [token, walletProjectFilter, walletEnvironmentFilter, walletEnabledFilter]);

  useEffect(() => {
    void loadPolicyPanel(token);
  }, [token, selectedProjectId]);

  useEffect(() => {
    void loadProjectEnvironments(token, selectedProjectId);
  }, [token, selectedProjectId]);

  function onSaveToken(event: FormEvent): void {
    event.preventDefault();
    const next = tokenInput.trim();
    storeToken(next);
    setToken(next);
    setMessage(
      next === '' ? 'Token cleared from this browser session.' : 'Token saved for this browser session.',
    );
  }

  async function onCheck(treasuryId: string): Promise<void> {
    setTreasuryBusyId(treasuryId);
    setMessage(undefined);
    try {
      const result = await checkTreasury(token, treasuryId);
      setTreasuries((current) => current.map((item) => (item.id === treasuryId ? result.data : item)));
      setMessage(`Check ${result.check.outcome} for ${result.data.address}`);
      if (treasuriesState === 'empty' || treasuriesState === 'idle') {
        setTreasuriesState('ready');
      }
    } catch (caught) {
      setTreasuriesError(formatError(caught));
      setTreasuriesState('error');
    } finally {
      setTreasuryBusyId(undefined);
    }
  }

  async function onTestEmail(): Promise<void> {
    setSessionBusy(true);
    setMessage(undefined);
    setSessionError(undefined);
    try {
      await sendTestEmail(token);
      setMessage('Test email requested. Check the operator inbox (or server logs if provider is log-only).');
    } catch (caught) {
      setSessionError(formatError(caught));
    } finally {
      setSessionBusy(false);
    }
  }

  async function onToggleProject(project: ProjectResource): Promise<void> {
    const nextEnabled = !project.enabled;
    const action = nextEnabled ? 'Enable' : 'Disable';
    if (!window.confirm(`${action} project "${project.slug}"?`)) {
      return;
    }
    setProjectBusyId(project.id);
    setProjectsError(undefined);
    setMessage(undefined);
    try {
      const updated = await setProjectEnabled(token, project.id, nextEnabled);
      setProjects((current) => current.map((item) => (item.id === project.id ? updated : item)));
      setMessage(`Project ${updated.slug} is now ${updated.enabled ? 'enabled' : 'disabled'}.`);
    } catch (caught) {
      setProjectsError(formatError(caught));
    } finally {
      setProjectBusyId(undefined);
    }
  }

  async function onToggleEnvironment(environment: EnvironmentResource): Promise<void> {
    const nextEnabled = !environment.enabled;
    const action = nextEnabled ? 'Enable' : 'Disable';
    if (!window.confirm(`${action} environment "${environment.slug}"?`)) {
      return;
    }
    setEnvironmentBusy(true);
    setEnvironmentError(undefined);
    setMessage(undefined);
    try {
      const updated = await setEnvironmentEnabled(token, environment.id, nextEnabled);
      setEnvironmentDetail(updated);
      setProjectEnvironments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setMessage(`Environment ${updated.slug} is now ${updated.enabled ? 'enabled' : 'disabled'}.`);
    } catch (caught) {
      setEnvironmentError(formatError(caught));
    } finally {
      setEnvironmentBusy(false);
    }
  }

  async function onToggleWallet(wallet: ManagedWalletResource): Promise<void> {
    const nextEnabled = !wallet.enabled;
    const action = nextEnabled ? 'Enable' : 'Disable';
    if (!window.confirm(`${action} wallet ${wallet.role} (${shortAddress(wallet.address)})?`)) {
      return;
    }
    setWalletBusyId(wallet.id);
    setWalletsError(undefined);
    setMessage(undefined);
    try {
      const updated = await setWalletEnabled(token, wallet.id, nextEnabled);
      setWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setPolicyWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setMessage(`Wallet ${updated.role} is now ${updated.enabled ? 'enabled' : 'disabled'}.`);
    } catch (caught) {
      setWalletsError(formatError(caught));
    } finally {
      setWalletBusyId(undefined);
    }
  }

  async function onToggleWalletReconciliation(wallet: ManagedWalletResource): Promise<void> {
    const nextEnabled = !wallet.reconciliationEnabled;
    const short = shortAddress(wallet.address);
    const confirmed = nextEnabled
      ? window.confirm(
          `Enable reconciliation for ${wallet.role} (${short})? The reconciler may fund this wallet automatically within 6 hours when its balance is below minimum.`,
        )
      : window.confirm(`Disable reconciliation for ${wallet.role} (${short})?`);
    if (!confirmed) {
      return;
    }
    setWalletBusyId(wallet.id);
    setWalletsError(undefined);
    setMessage(undefined);
    try {
      const updated = await setWalletReconciliationEnabled(token, wallet.id, nextEnabled);
      setWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setPolicyWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setMessage(
        `Reconciliation for wallet ${updated.role} is now ${updated.reconciliationEnabled ? 'on' : 'off'}.`,
      );
    } catch (caught) {
      setWalletsError(formatError(caught));
    } finally {
      setWalletBusyId(undefined);
    }
  }

  function beginEditPolicy(wallet: ManagedWalletResource): void {
    setEditingWalletId(wallet.id);
    setPolicyPreviewError(undefined);
    if (wallet.policy === null) {
      setMinimumEtherInput('');
      setTargetEtherInput('');
      setMaximumEtherInput('');
      return;
    }
    setMinimumEtherInput(formatWeiAsEther(wallet.policy.minimumBalanceWei));
    setTargetEtherInput(formatWeiAsEther(wallet.policy.targetBalanceWei));
    setMaximumEtherInput(formatWeiAsEther(wallet.policy.maximumTopUpWei));
  }

  function policyPreviewWei():
    | {
        readonly ok: true;
        readonly minimumBalanceWei: string;
        readonly targetBalanceWei: string;
        readonly maximumTopUpWei: string;
      }
    | { readonly ok: false; readonly message: string } {
    const minimum = parseEtherInputToWei(minimumEtherInput);
    if (!minimum.ok) {
      return { ok: false, message: `Minimum: ${minimum.message}` };
    }
    const target = parseEtherInputToWei(targetEtherInput);
    if (!target.ok) {
      return { ok: false, message: `Target: ${target.message}` };
    }
    const maximum = parseEtherInputToWei(maximumEtherInput);
    if (!maximum.ok) {
      return { ok: false, message: `Maximum top-up: ${maximum.message}` };
    }
    return {
      ok: true,
      minimumBalanceWei: minimum.wei,
      targetBalanceWei: target.wei,
      maximumTopUpWei: maximum.wei,
    };
  }

  async function onSavePolicy(wallet: ManagedWalletResource): Promise<void> {
    const preview = policyPreviewWei();
    if (!preview.ok) {
      setPolicyPreviewError(preview.message);
      return;
    }
    const confirmed = window.confirm(
      [
        `Save funding policy for ${wallet.role} (${shortAddress(wallet.address)})?`,
        '',
        `minimumBalanceWei: ${preview.minimumBalanceWei}`,
        `targetBalanceWei: ${preview.targetBalanceWei}`,
        `maximumTopUpWei: ${preview.maximumTopUpWei}`,
      ].join('\n'),
    );
    if (!confirmed) {
      return;
    }
    setPolicyBusyId(wallet.id);
    setPolicyError(undefined);
    setPolicyPreviewError(undefined);
    setMessage(undefined);
    try {
      const updated = await setWalletPolicy(token, wallet.id, {
        minimumBalanceWei: preview.minimumBalanceWei,
        targetBalanceWei: preview.targetBalanceWei,
        maximumTopUpWei: preview.maximumTopUpWei,
      });
      setPolicyWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setWallets((current) => current.map((item) => (item.id === wallet.id ? updated : item)));
      setEditingWalletId(undefined);
      setMessage(`Updated funding policy for ${updated.role}.`);
    } catch (caught) {
      setPolicyError(formatError(caught));
    } finally {
      setPolicyBusyId(undefined);
    }
  }

  const policyPreview = editingWalletId === undefined ? undefined : policyPreviewWei();

  const readinessPanel: ServiceReadinessPanelProps = {
    loadReadiness,
    readinessState,
    readinessError,
    readiness,
  };
  const treasuriesPanel: TreasuriesPanelProps = {
    loadTreasuries,
    loadTreasuryFundingHistory,
    token,
    treasuriesState,
    treasuriesError,
    treasuries,
    treasuryBusyId,
    onCheck,
    treasuryFundingHistoryState,
    treasuryFundingHistoryError,
    treasuryFundingHistory,
  };
  const projectsPanel: ProjectsPanelProps = {
    loadProjectsPanel,
    token,
    projectsState,
    projectsError,
    projectsTotal,
    projects,
    selectedProjectId,
    setSelectedProjectId,
    projectBusyId,
    onToggleProject,
  };
  const environmentsPanel: EnvironmentsPanelProps = {
    loadProjectEnvironments,
    loadEnvironmentDetail,
    token,
    selectedProjectId,
    envLookupId,
    setEnvLookupId,
    envListState,
    envListError,
    projectEnvironments,
    environmentState,
    environmentError,
    environmentDetail,
    environmentBusy,
    onToggleEnvironment,
  };
  const walletsPanel: ManagedWalletsPanelProps = {
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
  };
  const policyPanel: FundingPolicyPanelProps = {
    loadPolicyPanel,
    token,
    selectedProjectId,
    policyState,
    policyError,
    policyWalletsTotal,
    policyWallets,
    editingWalletId,
    beginEditPolicy,
    minimumEtherInput,
    setMinimumEtherInput,
    targetEtherInput,
    setTargetEtherInput,
    maximumEtherInput,
    setMaximumEtherInput,
    policyPreview,
    policyPreviewError,
    policyBusyId,
    onSavePolicy,
    setEditingWalletId,
    setPolicyPreviewError,
  };
  const historyPanel: FundingHistoryPanelProps = {
    loadFundingHistory,
    token,
    historyProjectFilter,
    setHistoryProjectFilter,
    historyStatusFilter,
    setHistoryStatusFilter,
    historyKindFilter,
    setHistoryKindFilter,
    fundingHistoryState,
    fundingHistoryError,
    fundingHistoryTotal,
    fundingHistory,
  };
  const reconciliationPanel: ReconciliationPanelProps = {
    loadReconciliationRuns,
    loadFindingAlerts,
    token,
    findingAlertsState,
    findingAlertsError,
    openFindingAlerts,
    treasuries,
    ackDraftByAlertId,
    ackErrorByAlertId,
    ackBusyId,
    setAckDraftByAlertId,
    onAcknowledgeFinding,
    acknowledgedFindingAlerts,
    acknowledgedFindingsExpanded,
    onToggleAcknowledgedFindings,
    reconciliationState,
    reconciliationError,
    reconciliationRunsTotal,
    reconciliationRuns,
    openFindingAlertsComplete,
    expandedCriticalEntityIds,
    setExpandedCriticalEntityIds,
    ackDraftByEntityId,
    setAckDraftByEntityId,
    ackErrorByEntityId,
    ackBusyEntityId,
    onAcknowledgeFindingByEntity,
    reconciliationDetailExpanded,
    onToggleReconciliationDetail,
  };

  return (
    <Shell
      route={route}
      tokenInput={tokenInput}
      setTokenInput={setTokenInput}
      sessionBusy={sessionBusy}
      onSaveToken={onSaveToken}
      sessionError={sessionError}
      token={token}
      onRefresh={() => {
        refreshAll(token);
      }}
      onTestEmail={onTestEmail}
      openFindingAlertCount={openFindingAlerts.length}
      findingAlertsError={findingAlertsError}
      findingAlertsFailed={findingAlertsState === 'error'}
    >
      {route === 'overview' ? <OverviewPage readiness={readinessPanel} treasuries={treasuriesPanel} /> : null}
      {route === 'treasuries' ? <TreasuriesPage treasuries={treasuriesPanel} /> : null}
      {route === 'wallets' ? (
        <WalletsPage
          projects={projectsPanel}
          environments={environmentsPanel}
          wallets={walletsPanel}
          policy={policyPanel}
        />
      ) : null}
      {route === 'funding' ? <FundingPage history={historyPanel} /> : null}
      {route === 'reconciliation' ? <ReconciliationPage panel={reconciliationPanel} /> : null}
      {route === 'alerts' ? <AlertsPage panel={reconciliationPanel} /> : null}
      {route === 'email' ? <EmailPage /> : null}
      {route === 'admin' ? <AdminPage /> : null}
      {message !== undefined ? <p className="toast ok">{message}</p> : null}
    </Shell>
  );
}
