import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiClientError,
  checkTreasury,
  fetchReadiness,
  getEnvironment,
  getWalletBalance,
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
  type EnvironmentResource,
  type FundingTransactionResource,
  type ManagedWalletResource,
  type ProjectResource,
  type ReadinessResponse,
  type ReconciliationRunResource,
  type TreasuryResource,
} from './api';

const TOKEN_STORAGE_KEY = 'chainbank.operatorToken';
/** Collapsed/expanded for Reconciliation warnings + run history only (TX.18). */
const RECON_DETAIL_STORAGE_KEY = 'chainbank.reconciliationDetailExpanded';
/**
 * Auto-load live balances only when the listed page is this size or smaller.
 * Each balance is one public-RPC read; TX.13 measured fine-at-5 / batch-at-50.
 */
const BALANCE_AUTO_LOAD_MAX = 25;
const WEI_DECIMALS = 18;
const WEI_PER_ETHER = 10n ** BigInt(WEI_DECIMALS);

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** Point-in-time live balance from GET /v1/wallets/:id/balance (C17). */
type WalletBalanceView =
  | { readonly status: 'loading' }
  | { readonly status: 'observed'; readonly wei: string; readonly ether: string; readonly observedAt: string }
  | { readonly status: 'unavailable'; readonly errorCode: string; readonly observedAt: string }
  | { readonly status: 'error'; readonly message: string };

function loadStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token.trim() === '') {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // sessionStorage may be unavailable; the in-memory token still works.
  }
}

/** Default collapsed — quiet when there are no critical findings (TX.18). */
function loadReconciliationDetailExpanded(): boolean {
  try {
    return localStorage.getItem(RECON_DETAIL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeReconciliationDetailExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(RECON_DETAIL_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // localStorage may be unavailable; in-memory toggle still works.
  }
}

function formatError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message} (${error.requestId})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

function statusClass(status: string): string {
  switch (status) {
    case 'healthy':
    case 'ok':
    case 'confirmed':
    case 'succeeded':
    case 'enabled':
    case 'complete':
      return 'badge badge-ok';
    case 'warning':
    case 'degraded':
    case 'submitted':
    case 'submission_unknown':
    case 'pending':
    case 'in_progress':
    case 'created':
    case 'incomplete':
      return 'badge badge-warn';
    case 'critical':
    case 'failed':
    case 'reverted':
    case 'abandoned':
    case 'dropped':
    case 'disabled':
      return 'badge badge-bad';
    case 'replaced':
    case 'not-run':
      return 'badge badge-unknown';
    default:
      return 'badge badge-unknown';
  }
}

function enabledBadge(enabled: boolean): string {
  return statusClass(enabled ? 'enabled' : 'disabled');
}

function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return '—';
  }
  return new Date(value).toLocaleString();
}

/** HH:MM:SS local — marks a balance as a point-in-time sample, not a live feed. */
function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function balancePolicyChip(
  balanceWei: string,
  policyMinimumWei: string | undefined,
): { readonly className: string; readonly label: string } {
  if (policyMinimumWei === undefined) {
    return { className: 'badge badge-unknown', label: 'no policy' };
  }
  // Funding uses strictly `<` minimum; at-or-above is fine (C14 / C2).
  if (BigInt(balanceWei) < BigInt(policyMinimumWei)) {
    return { className: 'badge badge-warn', label: 'below min' };
  }
  return { className: 'badge badge-ok', label: '≥ min' };
}

type FindingView = {
  readonly severity: 'critical' | 'warning' | 'unknown';
  readonly kind: string;
  readonly runId: string;
  readonly runStartedAt: string;
  readonly treasuryId: string | undefined;
  readonly transactionHash: string | undefined;
  readonly toAddress: string | undefined;
  readonly valueWei: string | undefined;
  readonly nonce: number | undefined;
  readonly blockNumber: string | undefined;
  readonly reason: string | undefined;
  readonly raw: Record<string, unknown>;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function findingSeverity(value: unknown): FindingView['severity'] {
  if (value === 'critical' || value === 'warning') {
    return value;
  }
  return 'unknown';
}

function toFindingViews(runs: readonly ReconciliationRunResource[]): readonly FindingView[] {
  const views: FindingView[] = [];
  for (const run of runs) {
    for (const raw of run.findings) {
      views.push({
        severity: findingSeverity(raw.severity),
        kind: asOptionalString(raw.kind) ?? 'unknown',
        runId: run.runId,
        runStartedAt: run.startedAt,
        treasuryId: asOptionalString(raw.treasuryId),
        transactionHash: asOptionalString(raw.transactionHash),
        toAddress: asOptionalString(raw.toAddress),
        valueWei: asOptionalString(raw.valueWei),
        nonce: asOptionalNumber(raw.nonce),
        blockNumber: asOptionalString(raw.blockNumber),
        reason: asOptionalString(raw.reason),
        raw,
      });
    }
  }
  return views;
}

function explorerTxUrl(
  treasuries: readonly TreasuryResource[],
  treasuryId: string | undefined,
  transactionHash: string | undefined,
): string | undefined {
  if (treasuryId === undefined || transactionHash === undefined) {
    return undefined;
  }
  const treasury = treasuries.find((item) => item.id === treasuryId);
  if (treasury === undefined) {
    return undefined;
  }
  // TreasuryResource.explorerUrl is `${base}/address/${addr}` — recover the base.
  const marker = '/address/';
  const index = treasury.explorerUrl.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }
  return `${treasury.explorerUrl.slice(0, index)}/tx/${transactionHash}`;
}

function runCompletionLabel(run: ReconciliationRunResource): {
  readonly className: string;
  readonly label: string;
} {
  // finishedAt null is unfinished / crashed — never render as a clean success (C15).
  if (run.finishedAt === null) {
    return { className: 'badge badge-warn', label: 'unfinished' };
  }
  if (run.errorCode !== null) {
    return { className: 'badge badge-bad', label: 'error' };
  }
  return { className: 'badge badge-ok', label: 'finished' };
}

/** Compact local M/D H:MM for the Reconciliation summary line. */
function formatCompactRunTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Operator-facing last-run clause for the always-visible summary (TX.18). */
function lastRunSummaryClause(run: ReconciliationRunResource): string {
  const when = formatCompactRunTime(run.startedAt);
  if (run.finishedAt === null) {
    return `last run ${when} — unfinished`;
  }
  if (run.errorCode !== null) {
    return `last run ${when} — error ${run.errorCode}`;
  }
  return `last run ${when} — funded ${String(run.walletsFunded)}, ${run.weiTransferredEther} ETH, scan ${run.outgoingScanStatus}`;
}

/**
 * Display-only ETH formatting. Uses BigInt so 18-decimal wei never loses precision
 * through JavaScript number (AGENTS.md §4).
 */
function formatWeiAsEther(weiDecimal: string): string {
  const wei = BigInt(weiDecimal);
  const whole = wei / WEI_PER_ETHER;
  const fraction = wei % WEI_PER_ETHER;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fractionText = fraction.toString().padStart(WEI_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

function parseEtherInputToWei(value: string): { ok: true; wei: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: false, message: 'Amount is required.' };
  }
  const normalized = trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (match === null) {
    return { ok: false, message: 'Enter a non-negative decimal ETH amount.' };
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > WEI_DECIMALS) {
    return { ok: false, message: `At most ${String(WEI_DECIMALS)} decimal places.` };
  }
  const paddedFraction = fraction.padEnd(WEI_DECIMALS, '0');
  const wei = BigInt(whole) * WEI_PER_ETHER + BigInt(paddedFraction);
  return { ok: true, wei: wei.toString() };
}

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

  const [reconciliationRuns, setReconciliationRuns] = useState<readonly ReconciliationRunResource[]>([]);
  const [reconciliationRunsTotal, setReconciliationRunsTotal] = useState(0);
  const [reconciliationState, setReconciliationState] = useState<LoadState>('idle');
  const [reconciliationError, setReconciliationError] = useState<string | undefined>();
  // Persists warnings + run-history visibility only — critical findings are never gated on this.
  const [reconciliationDetailExpanded, setReconciliationDetailExpanded] = useState(
    loadReconciliationDetailExpanded,
  );

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
      const next = await listFundingTransactions(activeToken.trim(), {
        projectId: historyProjectFilter.trim() === '' ? undefined : historyProjectFilter.trim(),
        status: historyStatusFilter === '' ? undefined : historyStatusFilter,
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
      const next = await listWallets(activeToken.trim(), {
        projectId: walletProjectFilter.trim() === '' ? undefined : walletProjectFilter.trim(),
        environmentId: walletEnvironmentFilter.trim() === '' ? undefined : walletEnvironmentFilter.trim(),
        enabled:
          walletEnabledFilter === ''
            ? undefined
            : walletEnabledFilter === 'true'
              ? true
              : walletEnabledFilter === 'false'
                ? false
                : undefined,
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
      const next = await listWallets(activeToken.trim(), {
        projectId: selectedProjectId.trim() === '' ? undefined : selectedProjectId.trim(),
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
    void loadReconciliationRuns(activeToken);
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
    void loadProjectsPanel(token);
    void loadReconciliationRuns(token);
  }, [token]);

  useEffect(() => {
    void loadFundingHistory(token);
  }, [token, historyProjectFilter, historyStatusFilter]);

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

  return (
    <div className="page">
      <header className="top-band">
        <div className="top-band-inner">
          <p className="eyebrow">Operator console</p>
          <h1 className="page-title">ChainBank</h1>
          <p className="lede">
            Observe the Sepolia treasury, manage projects, environments, wallets, and funding policies, and
            review funding history. Never paste a private key or seed phrase here.
          </p>
        </div>
      </header>

      <main className="page-body">
        <section className="panel">
          <h2 className="section-title">Session</h2>
          <form className="token-form" onSubmit={onSaveToken}>
            <label htmlFor="token">Operator bearer token</label>
            <input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="cb_…"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <div className="row">
              <button type="submit" disabled={sessionBusy}>
                Save for this tab
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sessionBusy}
                onClick={() => {
                  refreshAll(token);
                }}
              >
                Refresh all
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sessionBusy || token === ''}
                onClick={() => void onTestEmail()}
              >
                Send test email
              </button>
            </div>
            <p className="hint">Stored in sessionStorage only. Never put a private key here.</p>
            {sessionError !== undefined ? <p className="error-inline">{sessionError}</p> : null}
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Service readiness</h2>
            <button type="button" className="secondary" onClick={() => void loadReadiness()}>
              Reload
            </button>
          </div>
          {readinessState === 'loading' || readinessState === 'idle' ? (
            <p className="muted">Loading…</p>
          ) : null}
          {readinessState === 'error' ? <p className="error-inline">{readinessError}</p> : null}
          {readinessState === 'ready' && readiness !== undefined ? (
            <>
              <p>
                Overall <span className={statusClass(readiness.status)}>{readiness.status}</span>
                <span className="muted"> · checked {new Date(readiness.checkedAt).toLocaleString()}</span>
              </p>
              <ul className="plain">
                {readiness.components.map((component) => (
                  <li key={component.name}>
                    <span className={statusClass(component.status)}>{component.status}</span> {component.name}
                    {component.detail !== null ? <span className="muted"> — {component.detail}</span> : null}
                  </li>
                ))}
              </ul>
              <h3>Heartbeats</h3>
              {readiness.heartbeats.length === 0 ? (
                <p className="muted">No heartbeats recorded yet.</p>
              ) : (
                <ul className="plain">
                  {readiness.heartbeats.map((heartbeat) => (
                    <li key={heartbeat.serviceRole}>
                      <code>{heartbeat.serviceRole}</code>
                      <span className="muted"> · {new Date(heartbeat.lastSeenAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Treasuries</h2>
            <button type="button" className="secondary" onClick={() => void loadTreasuries(token)}>
              Reload
            </button>
          </div>
          {token === '' ? <p className="muted">Paste an operator token to load treasuries.</p> : null}
          {token !== '' && treasuriesState === 'loading' ? <p className="muted">Loading…</p> : null}
          {treasuriesState === 'error' ? <p className="error-inline">{treasuriesError}</p> : null}
          {treasuriesState === 'empty' ? <p className="muted">No enabled treasuries returned.</p> : null}
          {treasuriesState === 'ready' ? (
            <div className="treasury-list">
              {treasuries.map((treasury) => (
                <article key={treasury.id} className="treasury">
                  <div className="treasury-head">
                    <span className={statusClass(treasury.status)}>{treasury.status}</span>
                    <h3>{treasury.chain.displayName}</h3>
                  </div>
                  <p className="mono">
                    <a href={treasury.explorerUrl} target="_blank" rel="noreferrer">
                      {treasury.address}
                    </a>
                  </p>
                  <dl className="facts">
                    <div>
                      <dt>Balance</dt>
                      <dd className="mono">
                        {treasury.balance.ether === null
                          ? 'unavailable'
                          : `${treasury.balance.ether} ${treasury.chain.nativeSymbol}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Spendable</dt>
                      <dd className="mono">
                        {treasury.spendable.ether === null
                          ? '—'
                          : `${treasury.spendable.ether} ${treasury.chain.nativeSymbol}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Last checked</dt>
                      <dd>
                        {treasury.lastCheckedAt === null
                          ? 'never'
                          : new Date(treasury.lastCheckedAt).toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Thresholds</dt>
                      <dd className="mono">
                        warn {treasury.thresholds.warningEther} · crit {treasury.thresholds.criticalEther} ·
                        reserve {treasury.thresholds.minimumReserveEther}
                      </dd>
                    </div>
                  </dl>
                  {treasury.lastCheckErrorCode !== null ? (
                    <p className="error-inline">Last error: {treasury.lastCheckErrorCode}</p>
                  ) : null}
                  <button
                    type="button"
                    disabled={treasuryBusyId === treasury.id}
                    onClick={() => void onCheck(treasury.id)}
                  >
                    Check now
                  </button>
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Reconciliation</h2>
            <button type="button" className="secondary" onClick={() => void loadReconciliationRuns(token)}>
              Reload
            </button>
          </div>
          {token === '' ? (
            <p className="muted">Paste an operator token to load reconciliation runs.</p>
          ) : (
            <>
              {reconciliationState === 'loading' ? <p className="muted">Loading…</p> : null}
              {reconciliationState === 'error' ? <p className="error-inline">{reconciliationError}</p> : null}
              {reconciliationState === 'empty' ? (
                <p className="muted">
                  No reconciliation runs returned ({String(reconciliationRunsTotal)} total).
                </p>
              ) : null}
              {reconciliationState === 'ready'
                ? (() => {
                    const findings = toFindingViews(reconciliationRuns);
                    const criticalFindings = findings.filter((item) => item.severity === 'critical');
                    const warningFindings = findings.filter((item) => item.severity === 'warning');
                    const otherFindings = findings.filter(
                      (item) => item.severity !== 'critical' && item.severity !== 'warning',
                    );
                    const newestRun = reconciliationRuns[0];
                    const criticalCount = criticalFindings.length;
                    const hasCritical = criticalCount > 0;
                    const criticalLabel =
                      criticalCount === 1
                        ? '1 critical finding'
                        : `${String(criticalCount)} critical findings`;
                    return (
                      <>
                        <div className={hasCritical ? 'recon-summary recon-summary-alert' : 'recon-summary'}>
                          <button
                            type="button"
                            className="recon-toggle"
                            aria-expanded={reconciliationDetailExpanded}
                            aria-controls="reconciliation-detail"
                            title={
                              reconciliationDetailExpanded
                                ? 'Collapse warnings and run history'
                                : 'Expand warnings and run history'
                            }
                            onClick={onToggleReconciliationDetail}
                          >
                            {reconciliationDetailExpanded ? '−' : '+'}
                          </button>
                          <p className="recon-summary-text">
                            <span>
                              {String(reconciliationRunsTotal)} run
                              {reconciliationRunsTotal === 1 ? '' : 's'}
                            </span>
                            <span aria-hidden="true"> · </span>
                            {hasCritical ? (
                              <span className="recon-critical-callout">{criticalLabel}</span>
                            ) : (
                              <span>{criticalLabel}</span>
                            )}
                            {otherFindings.length > 0 ? (
                              <>
                                <span aria-hidden="true"> · </span>
                                <span className="recon-critical-callout">
                                  {otherFindings.length === 1
                                    ? '1 unclassified finding'
                                    : `${String(otherFindings.length)} unclassified findings`}
                                </span>
                              </>
                            ) : null}
                            {newestRun !== undefined ? (
                              <>
                                <span aria-hidden="true"> · </span>
                                <span>{lastRunSummaryClause(newestRun)}</span>
                              </>
                            ) : null}
                          </p>
                        </div>

                        {/*
                          Critical findings stay outside the collapse control. Collapsing
                          must never hide them — that was the whole point of this panel.
                        */}
                        {hasCritical ? (
                          <div className="finding-list recon-critical-always">
                            {criticalFindings.map((finding, index) => {
                              const href = explorerTxUrl(
                                treasuries,
                                finding.treasuryId,
                                finding.transactionHash,
                              );
                              return (
                                <article
                                  key={`critical-${finding.runId}-${finding.kind}-${String(index)}`}
                                  className="finding finding-critical"
                                >
                                  <div className="finding-head">
                                    <span className="badge badge-bad badge-square">critical</span>
                                    <code>{finding.kind}</code>
                                  </div>
                                  <dl className="facts">
                                    <div>
                                      <dt>Transaction</dt>
                                      <dd className="mono">
                                        {finding.transactionHash === undefined ? (
                                          '—'
                                        ) : href === undefined ? (
                                          finding.transactionHash
                                        ) : (
                                          <a href={href} target="_blank" rel="noreferrer">
                                            {shortAddress(finding.transactionHash)}
                                          </a>
                                        )}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Destination</dt>
                                      <dd className="mono">
                                        {finding.toAddress === undefined
                                          ? '—'
                                          : shortAddress(finding.toAddress)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Value</dt>
                                      <dd className="mono">
                                        {finding.valueWei === undefined
                                          ? '—'
                                          : `${formatWeiAsEther(finding.valueWei)} ETH`}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Nonce</dt>
                                      <dd className="mono">
                                        {finding.nonce === undefined ? '—' : String(finding.nonce)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Block</dt>
                                      <dd className="mono">{finding.blockNumber ?? '—'}</dd>
                                    </div>
                                    <div>
                                      <dt>Run</dt>
                                      <dd>
                                        <code>{finding.runId}</code>
                                        <span className="muted">
                                          {' '}
                                          · {formatTimestamp(finding.runStartedAt)}
                                        </span>
                                      </dd>
                                    </div>
                                  </dl>
                                  {finding.reason !== undefined ? (
                                    <p className="muted">{finding.reason}</p>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : null}

                        {/*
                          Unclassified findings stay outside the collapse too (planner
                          review, TX.18). A severity this dashboard cannot recognise is
                          not evidence that the finding is minor — C18's rule is that the
                          system must not make the benign-vs-hostile call it cannot make.
                          Filing them under "Warning findings" asserted exactly that, and
                          the default-collapsed state then hid them entirely.
                        */}
                        {otherFindings.length > 0 ? (
                          <div className="finding-list recon-critical-always">
                            {otherFindings.map((finding, index) => (
                              <article
                                key={`unclassified-${finding.runId}-${finding.kind}-${String(index)}`}
                                className="finding finding-unknown"
                              >
                                <div className="finding-head">
                                  <span className="badge badge-unknown badge-square">unclassified</span>
                                  <code>{finding.kind}</code>
                                </div>
                                <dl className="facts">
                                  <div>
                                    <dt>Severity</dt>
                                    <dd>
                                      <code>{finding.severity}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Run</dt>
                                    <dd>
                                      <code>{finding.runId}</code>
                                      <span className="muted">
                                        {' '}
                                        · {formatTimestamp(finding.runStartedAt)}
                                      </span>
                                    </dd>
                                  </div>
                                </dl>
                                {finding.reason !== undefined ? (
                                  <p className="muted">{finding.reason}</p>
                                ) : null}
                              </article>
                            ))}
                          </div>
                        ) : null}

                        {reconciliationDetailExpanded ? (
                          <div id="reconciliation-detail">
                            <p className="muted">
                              Showing {String(reconciliationRuns.length)} of {String(reconciliationRunsTotal)}{' '}
                              runs (newest first). Findings below are from this page only — older critical
                              findings outside the window will not appear here.
                            </p>

                            {!hasCritical ? (
                              <p className="muted">No critical findings in the loaded runs.</p>
                            ) : null}

                            <h3 className="subsection-title">Warning findings</h3>
                            {warningFindings.length === 0 ? (
                              <p className="muted">No warning findings in the loaded runs.</p>
                            ) : (
                              <div className="finding-list">
                                {warningFindings.map((finding, index) => (
                                  <article
                                    key={`warn-${finding.runId}-${finding.kind}-${String(index)}`}
                                    className={
                                      finding.severity === 'warning'
                                        ? 'finding finding-warning'
                                        : 'finding finding-unknown'
                                    }
                                  >
                                    <div className="finding-head">
                                      <span
                                        className={
                                          finding.severity === 'warning'
                                            ? 'badge badge-warn'
                                            : 'badge badge-unknown'
                                        }
                                      >
                                        {finding.severity}
                                      </span>
                                      <code>{finding.kind}</code>
                                    </div>
                                    <p className="muted">
                                      Run <code>{finding.runId}</code> ·{' '}
                                      {formatTimestamp(finding.runStartedAt)}
                                      {finding.reason !== undefined ? ` · ${finding.reason}` : ''}
                                    </p>
                                  </article>
                                ))}
                              </div>
                            )}

                            <h3 className="subsection-title">Run history</h3>
                            <div className="table-wrap">
                              <table className="data-table">
                                <thead>
                                  <tr>
                                    <th>Started</th>
                                    <th>Finished</th>
                                    <th>Assessed</th>
                                    <th>Funded</th>
                                    <th>Blocked</th>
                                    <th>Failed</th>
                                    <th>Transferred</th>
                                    <th>Scan</th>
                                    <th>Status</th>
                                    <th>Error</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {reconciliationRuns.map((run) => {
                                    const completion = runCompletionLabel(run);
                                    return (
                                      <tr key={run.id}>
                                        <td>{formatTimestamp(run.startedAt)}</td>
                                        <td>
                                          {run.finishedAt === null ? (
                                            <span className="badge badge-warn">unfinished</span>
                                          ) : (
                                            formatTimestamp(run.finishedAt)
                                          )}
                                        </td>
                                        <td className="mono">{String(run.walletsAssessed)}</td>
                                        <td className="mono">{String(run.walletsFunded)}</td>
                                        <td className="mono">{String(run.walletsBlocked)}</td>
                                        <td className="mono">{String(run.walletsFailed)}</td>
                                        <td className="mono">{run.weiTransferredEther} ETH</td>
                                        <td>
                                          <span className={statusClass(run.outgoingScanStatus)}>
                                            {run.outgoingScanStatus}
                                          </span>
                                        </td>
                                        <td>
                                          <span className={completion.className}>{completion.label}</span>
                                        </td>
                                        <td className="mono">{run.errorCode ?? '—'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : null}
                      </>
                    );
                  })()
                : null}
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Projects</h2>
            <button type="button" className="secondary" onClick={() => void loadProjectsPanel(token)}>
              Reload
            </button>
          </div>
          {token === '' ? <p className="muted">Paste an operator token to load projects.</p> : null}
          {token !== '' && projectsState === 'loading' ? <p className="muted">Loading…</p> : null}
          {projectsState === 'error' ? <p className="error-inline">{projectsError}</p> : null}
          {projectsState === 'empty' ? (
            <p className="muted">No projects returned ({String(projectsTotal)} total).</p>
          ) : null}
          {projectsState === 'ready' ? (
            <>
              <p className="muted">
                Showing {String(projects.length)} of {String(projectsTotal)} projects. Select one to scope
                environments and funding policy.
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Slug</th>
                      <th>Name</th>
                      <th>Enabled</th>
                      <th>Select</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr
                        key={project.id}
                        className={selectedProjectId === project.id ? 'row-selected' : undefined}
                      >
                        <td className="mono">{project.slug}</td>
                        <td>{project.name}</td>
                        <td>
                          <span className={enabledBadge(project.enabled)}>
                            {project.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setSelectedProjectId(project.id);
                            }}
                          >
                            {selectedProjectId === project.id ? 'Selected' : 'Select'}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={project.enabled ? 'secondary' : undefined}
                            disabled={projectBusyId === project.id}
                            onClick={() => void onToggleProject(project)}
                          >
                            {project.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Environments</h2>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void loadProjectEnvironments(token, selectedProjectId);
                if (envLookupId.trim() !== '') {
                  void loadEnvironmentDetail(token, envLookupId);
                }
              }}
            >
              Reload
            </button>
          </div>
          {token === '' ? <p className="muted">Paste an operator token to load environments.</p> : null}
          {token !== '' && selectedProjectId === '' ? (
            <p className="muted">Select a project above to list its environments.</p>
          ) : null}
          {token !== '' && selectedProjectId !== '' ? (
            <>
              <p className="hint">Load any environment by UUID below for full detail and enable/disable.</p>
              {envListState === 'loading' ? <p className="muted">Loading environments…</p> : null}
              {envListState === 'error' ? <p className="error-inline">{envListError}</p> : null}
              {envListState === 'empty' ? (
                <p className="muted">No environments registered for this project yet.</p>
              ) : null}
              {envListState === 'ready' ? (
                <ul className="plain env-list">
                  {projectEnvironments.map((environment) => (
                    <li key={environment.id}>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          setEnvLookupId(environment.id);
                          void loadEnvironmentDetail(token, environment.id);
                        }}
                      >
                        <code>{environment.slug}</code>
                      </button>{' '}
                      <span className={enabledBadge(environment.enabled)}>
                        {environment.enabled ? 'enabled' : 'disabled'}
                      </span>
                      <span className="muted"> — {environment.name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <form
                className="filters row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadEnvironmentDetail(token, envLookupId);
                }}
              >
                <label htmlFor="environment-id">Environment ID</label>
                <input
                  id="environment-id"
                  name="environment-id"
                  type="text"
                  spellCheck={false}
                  placeholder="UUID"
                  value={envLookupId}
                  onChange={(event) => setEnvLookupId(event.target.value)}
                />
                <button type="submit">Load detail</button>
              </form>

              {environmentState === 'loading' ? <p className="muted">Loading environment detail…</p> : null}
              {environmentState === 'error' ? <p className="error-inline">{environmentError}</p> : null}
              {environmentState === 'ready' && environmentDetail !== undefined ? (
                <article className="treasury">
                  <div className="treasury-head">
                    <span className={enabledBadge(environmentDetail.enabled)}>
                      {environmentDetail.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <h3>
                      {environmentDetail.slug} <span className="muted">· {environmentDetail.name}</span>
                    </h3>
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>ID</dt>
                      <dd className="mono">{environmentDetail.id}</dd>
                    </div>
                    <div>
                      <dt>Project ID</dt>
                      <dd className="mono">{environmentDetail.projectId}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{formatTimestamp(environmentDetail.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatTimestamp(environmentDetail.updatedAt)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className={environmentDetail.enabled ? 'secondary' : undefined}
                    disabled={environmentBusy}
                    onClick={() => void onToggleEnvironment(environmentDetail)}
                  >
                    {environmentDetail.enabled ? 'Disable' : 'Enable'}
                  </button>
                </article>
              ) : null}
            </>
          ) : null}
        </section>

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
                    {wallets.length <= BALANCE_AUTO_LOAD_MAX
                      ? ' Balances load automatically for this list (one live RPC read each); Check balances refreshes.'
                      : ` Balances are not auto-loaded above ${String(BALANCE_AUTO_LOAD_MAX)} listed wallets (one live RPC read each). Use Check balances.`}
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
                                  {shortAddress(wallet.address)}
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
                                      const chip = balancePolicyChip(
                                        balanceView.wei,
                                        wallet.policy?.minimumBalanceWei,
                                      );
                                      return <span className={chip.className}>{chip.label}</span>;
                                    })()}
                                    <div
                                      className="muted tiny"
                                      title={`Observed at ${balanceView.observedAt}`}
                                    >
                                      as of {formatClockTime(balanceView.observedAt)}
                                    </div>
                                  </>
                                ) : null}
                                {balanceView?.status === 'unavailable' ? (
                                  <>
                                    <span className="badge badge-unknown">unavailable</span>
                                    <div className="muted tiny" title={balanceView.errorCode}>
                                      as of {formatClockTime(balanceView.observedAt)}
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
                                <span className={enabledBadge(wallet.enabled)}>
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

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Funding policy</h2>
            <button type="button" className="secondary" onClick={() => void loadPolicyPanel(token)}>
              Reload
            </button>
          </div>
          {token === '' ? <p className="muted">Paste an operator token to load funding policies.</p> : null}
          {token !== '' ? (
            <>
              <p className="hint">
                Amounts are entered in ETH and converted once to exact decimal wei strings before submit.
                Confirm shows the wei values the API will receive.
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
                          <button type="button" className="secondary" onClick={() => beginEditPolicy(wallet)}>
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

        <section className="panel">
          <div className="panel-head">
            <h2 className="section-title">Funding history</h2>
            <button type="button" className="secondary" onClick={() => void loadFundingHistory(token)}>
              Reload
            </button>
          </div>
          {token === '' ? (
            <p className="muted">Paste an operator token to load funding history.</p>
          ) : (
            <>
              <div className="filters row">
                <label htmlFor="history-project">Project ID</label>
                <input
                  id="history-project"
                  name="history-project"
                  type="text"
                  spellCheck={false}
                  placeholder="UUID (optional)"
                  value={historyProjectFilter}
                  onChange={(event) => setHistoryProjectFilter(event.target.value)}
                />
                <label htmlFor="history-status">Status</label>
                <select
                  id="history-status"
                  name="history-status"
                  value={historyStatusFilter}
                  onChange={(event) => setHistoryStatusFilter(event.target.value)}
                >
                  <option value="">All statuses</option>
                  <option value="confirmed">confirmed</option>
                  <option value="submitted">submitted</option>
                  <option value="submission_unknown">submission_unknown</option>
                  <option value="failed">failed</option>
                  <option value="reverted">reverted</option>
                  <option value="replaced">replaced</option>
                  <option value="dropped">dropped</option>
                  <option value="created">created</option>
                </select>
              </div>
              {fundingHistoryState === 'loading' ? <p className="muted">Loading…</p> : null}
              {fundingHistoryState === 'error' ? <p className="error-inline">{fundingHistoryError}</p> : null}
              {fundingHistoryState === 'empty' ? (
                <p className="muted">
                  No funding transactions returned ({String(fundingHistoryTotal)} total).
                </p>
              ) : null}
              {fundingHistoryState === 'ready' ? (
                <>
                  <p className="muted">
                    Showing {String(fundingHistory.length)} of {String(fundingHistoryTotal)} transactions
                    (newest first).
                  </p>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Project / env</th>
                          <th>Wallet</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Transaction</th>
                          <th>Created</th>
                          <th>Confirmed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fundingHistory.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <strong>{row.project.slug}</strong>
                              <span className="muted"> / {row.environment.slug}</span>
                            </td>
                            <td className="mono">
                              {row.wallet.role}{' '}
                              <span title={row.wallet.address}>{shortAddress(row.wallet.address)}</span>
                            </td>
                            <td className="mono">
                              {row.amountEther} {row.chain.nativeSymbol}
                            </td>
                            <td>
                              <span className={statusClass(row.status)}>{row.status}</span>
                            </td>
                            <td className="mono">
                              {row.explorerUrl === null ? (
                                '—'
                              ) : (
                                <a href={row.explorerUrl} target="_blank" rel="noreferrer">
                                  {shortAddress(row.transactionHash ?? '')}
                                </a>
                              )}
                            </td>
                            <td>{formatTimestamp(row.createdAt)}</td>
                            <td>{formatTimestamp(row.confirmedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </>
          )}
        </section>

        {message !== undefined ? <p className="toast ok">{message}</p> : null}
      </main>
    </div>
  );
}
