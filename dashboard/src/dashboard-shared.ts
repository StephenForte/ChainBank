import { ApiClientError, type AlertResource, type ReconciliationRunResource, type TreasuryResource } from './api';

export const TOKEN_STORAGE_KEY = 'chainbank.operatorToken';
/** Collapsed/expanded for Reconciliation warnings + run history only (TX.18). */
export const RECON_DETAIL_STORAGE_KEY = 'chainbank.reconciliationDetailExpanded';
export const ACK_FINDINGS_STORAGE_KEY = 'chainbank.acknowledgedFindingsExpanded';
/**
 * Auto-load live balances only when the listed page is this size or smaller.
 * Each balance is one public-RPC read; TX.13 measured fine-at-5 / batch-at-50.
 */
export const BALANCE_AUTO_LOAD_MAX = 25;
export const WEI_DECIMALS = 18;
export const WEI_PER_ETHER = 10n ** BigInt(WEI_DECIMALS);

export type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** Point-in-time live balance from GET /v1/wallets/:id/balance (C17). */
export type WalletBalanceView =
  | { readonly status: 'loading' }
  | { readonly status: 'observed'; readonly wei: string; readonly ether: string; readonly observedAt: string }
  | { readonly status: 'unavailable'; readonly errorCode: string; readonly observedAt: string }
  | { readonly status: 'error'; readonly message: string };

export function loadStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeToken(token: string): void {
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

/** Default collapsed — quiet when there are no unacknowledged critical findings (TX.18 / TX.20). */
export function loadReconciliationDetailExpanded(): boolean {
  try {
    return localStorage.getItem(RECON_DETAIL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function storeReconciliationDetailExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(RECON_DETAIL_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // localStorage may be unavailable; in-memory toggle still works.
  }
}

/**
 * Default collapsed. These are findings an operator has already stood down with
 * a note, so they are record rather than signal — never an unacknowledged
 * critical, which lives outside the collapse entirely (C17 / TX.20).
 */
export function loadAcknowledgedFindingsExpanded(): boolean {
  try {
    return localStorage.getItem(ACK_FINDINGS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function storeAcknowledgedFindingsExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(ACK_FINDINGS_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // localStorage may be unavailable; in-memory toggle still works.
  }
}

export function formatError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.code}: ${error.message} (${error.requestId})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

export function statusClass(status: string): string {
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

export function enabledBadge(enabled: boolean): string {
  return statusClass(enabled ? 'enabled' : 'disabled');
}

export function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatTimestamp(value: string | null): string {
  if (value === null) {
    return '—';
  }
  return new Date(value).toLocaleString();
}

/** HH:MM:SS local — marks a balance as a point-in-time sample, not a live feed. */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function balancePolicyChip(
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

export type FindingView = {
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

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function findingSeverity(value: unknown): FindingView['severity'] {
  if (value === 'critical' || value === 'warning') {
    return value;
  }
  return 'unknown';
}

export function toFindingViews(runs: readonly ReconciliationRunResource[]): readonly FindingView[] {
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

/** A 32-byte transaction hash. Anything else is not linkable to an explorer. */
export const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Client-side mirror of C18 `treasuryFindingAlertEntityId`. Returns undefined when
 * the finding cannot be keyed — absence of a key is not acknowledgement (TX.20).
 */
export function findingAlertEntityId(finding: FindingView): string | undefined {
  if (finding.kind === 'outgoing_scan_incomplete') {
    const errorCode = asOptionalString(finding.raw.errorCode);
    if (finding.treasuryId === undefined || errorCode === undefined) {
      return undefined;
    }
    // NOT lowercased. C18 stores this key with the errorCode case preserved
    // (`…:RPC_UNAVAILABLE`), and the alerts repository matches `entity_id`
    // exactly. Lowercasing here and sending that to the acknowledge endpoint
    // missed the real open row, created a second acknowledged row under the
    // lowercased id, and left the original alert open behind a 200 response.
    // Only the transaction-hash branch may lowercase, because C18 lowercases
    // that one at the source.
    return `outgoing_scan_incomplete:${finding.treasuryId}:${errorCode}`;
  }
  if (finding.transactionHash !== undefined) {
    return finding.transactionHash.toLowerCase();
  }
  return undefined;
}

/** Comparison form only — never sent to the API. See findingAlertEntityId. */
export function findingAlertMatchKey(finding: FindingView): string | undefined {
  return findingAlertEntityId(finding)?.toLowerCase();
}

/**
 * Alerts fetch succeeded. Only then may a critical leave the always-visible block.
 * `loading` / `error` / `idle` must never quietly demote (TX.20 fail-closed).
 */
export function areFindingAlertsResolved(state: LoadState): boolean {
  return state === 'ready' || state === 'empty';
}

/**
 * Demote only on positive evidence of acknowledgement. Open preferred over
 * acknowledged for a shared entityId (C20 condition recurrence). No matching
 * alert row → unacknowledged. Unresolved alerts fetch → unacknowledged.
 *
 * `openAlertsComplete` is load-bearing: demotion requires proving the *absence*
 * of an open row. A truncated open page (total > fetched) cannot prove that —
 * an open alert on a later page plus an acknowledged match on page one would
 * otherwise falsely demote (C20 condition recurrence makes that real).
 */
export function isCriticalFindingAcknowledged(
  finding: FindingView,
  findingAlertsState: LoadState,
  openFindingAlerts: readonly AlertResource[],
  acknowledgedFindingAlerts: readonly AlertResource[],
  openAlertsComplete: boolean,
): boolean {
  if (!areFindingAlertsResolved(findingAlertsState) || !openAlertsComplete) {
    return false;
  }
  const matchKey = findingAlertMatchKey(finding);
  if (matchKey === undefined) {
    return false;
  }
  if (openFindingAlerts.some((alert) => alert.entityId.toLowerCase() === matchKey)) {
    return false;
  }
  return acknowledgedFindingAlerts.some((alert) => alert.entityId.toLowerCase() === matchKey);
}

export function matchingAcknowledgedAlert(
  finding: FindingView,
  acknowledgedFindingAlerts: readonly AlertResource[],
): AlertResource | undefined {
  const matchKey = findingAlertMatchKey(finding);
  if (matchKey === undefined) {
    return undefined;
  }
  return acknowledgedFindingAlerts.find((alert) => alert.entityId.toLowerCase() === matchKey);
}

/** Summary clause that distinguishes unacknowledged from acknowledged (TX.20). */
export function criticalFindingsSummaryLabel(
  unacknowledgedCount: number,
  acknowledgedCount: number,
  alertsResolved: boolean,
): string {
  const total = unacknowledgedCount + acknowledgedCount;
  if (total === 0) {
    return '0 critical findings';
  }
  // Until alerts resolve, every critical is treated as needing attention — do not
  // claim acknowledgement we have not proven.
  if (!alertsResolved) {
    return total === 1 ? '1 critical finding' : `${String(total)} critical findings`;
  }
  if (acknowledgedCount === 0) {
    return unacknowledgedCount === 1
      ? '1 unacknowledged critical finding'
      : `${String(unacknowledgedCount)} unacknowledged critical findings`;
  }
  if (unacknowledgedCount === 0) {
    return acknowledgedCount === 1
      ? '1 acknowledged critical finding'
      : `${String(acknowledgedCount)} acknowledged critical findings`;
  }
  return (
    `${String(unacknowledgedCount)} unacknowledged · ${String(acknowledgedCount)} acknowledged ` +
    `critical finding${total === 1 ? '' : 's'}`
  );
}

/**
 * C18 routes two natures through `treasury_finding` (C20): an event keyed by
 * transaction hash, and a condition keyed `outgoing_scan_incomplete:<treasury>:<code>`.
 * Only the first is a transaction, so only the first gets a "Transaction" label.
 */
export function findingEntityLabel(entityId: string): string {
  return TRANSACTION_HASH_PATTERN.test(entityId) ? 'Transaction' : 'Finding key';
}

export function explorerTxUrl(
  treasuries: readonly TreasuryResource[],
  treasuryId: string | undefined,
  transactionHash: string | undefined,
): string | undefined {
  if (treasuryId === undefined || transactionHash === undefined) {
    return undefined;
  }
  // Fail closed on anything that is not a transaction hash. A condition-kind
  // finding key would otherwise render as a live /tx/ link to a transaction
  // that does not exist, on an incident record.
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
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

export function runCompletionLabel(run: ReconciliationRunResource): {
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
export function formatCompactRunTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Operator-facing last-run clause for the always-visible summary (TX.18). */
export function lastRunSummaryClause(run: ReconciliationRunResource): string {
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
export function formatWeiAsEther(weiDecimal: string): string {
  const wei = BigInt(weiDecimal);
  const whole = wei / WEI_PER_ETHER;
  const fraction = wei % WEI_PER_ETHER;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fractionText = fraction.toString().padStart(WEI_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

/**
 * Wei arriving from a fail-permissive source — a C19 finding or C20 alert
 * metadata — where the value is passed through unvalidated by design.
 *
 * `formatWeiAsEther` calls `BigInt()`, which throws on anything that is not a
 * decimal integer. Panel boundaries (C22) are the last line of defence; this
 * helper stays fail-permissive so hostile shapes degrade to labelled text
 * instead of a permanent "unavailable" box. Verified pre-boundary: a single
 * malformed `valueWei` (`"1.5"`) produced zero rendered panels.
 *
 * So: never throw, and never invent a number. An unparseable amount is shown
 * verbatim and labelled, the same way TX.18 treats a severity it cannot
 * classify — the system must not pretend to understand evidence it doesn't.
 */
export function formatFindingWei(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return `${String(value)} (unparseable wei)`;
  }
  return `${formatWeiAsEther(value)} ETH`;
}

export function parseEtherInputToWei(value: string): { ok: true; wei: string } | { ok: false; message: string } {
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
