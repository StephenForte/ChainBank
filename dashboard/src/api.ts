export type TreasuryStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface TreasuryResource {
  readonly id: string;
  readonly kind?: 'external' | 'operational';
  readonly displayKind?: 'Public' | 'Private';
  readonly status: TreasuryStatus;
  readonly enabled: boolean;
  readonly address: string;
  readonly explorerUrl: string;
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly balance: {
    readonly wei: string | null;
    readonly ether: string | null;
    readonly observedAt: string | null;
  };
  readonly spendable: {
    readonly wei: string | null;
    readonly ether: string | null;
  };
  readonly thresholds: {
    readonly warningEther: string;
    readonly criticalEther: string;
    readonly recoveryEther: string;
    readonly minimumReserveEther: string;
  };
  readonly lastCheckedAt: string | null;
  readonly lastCheckErrorCode: string | null;
}

export interface ReadinessResponse {
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly checkedAt: string;
  readonly components: readonly {
    readonly name: string;
    readonly status: string;
    readonly detail: string | null;
  }[];
  readonly heartbeats: readonly {
    readonly serviceRole: string;
    readonly lastSeenAt: string;
  }[];
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly requestId: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.error.code;
    this.requestId = body.requestId;
  }
}

/** C31 accepts only this literal. It is not a secret; it proves the caller can set a header. */
export const SESSION_HEADER_NAME = 'X-ChainBank-Session';
export const SESSION_HEADER_VALUE = '1';

const CURRENT_PASSWORD_REJECTED = 'The current password is not valid.';

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | undefined;
let sessionEpoch = 0;

/**
 * Invalidates 401s from requests that started in an earlier session. An
 * in-flight call can return 401 after the next login; that response belongs
 * to the session that started it.
 */
export function bumpDashboardSessionEpoch(): void {
  sessionEpoch += 1;
}

/** Installed by `useSession` for the signed-in → signed-out transition. */
export function setDashboardUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(path: string, message: string, epoch: number): void {
  if (epoch !== sessionEpoch) {
    return;
  }
  // Login has no session yet. A wrong current password is 401 while the cookie
  // remains valid (change-password.ts). `GET /v1/auth/me` is the probe that
  // decides unknown → signed-out and must not announce "session ended".
  if (path === '/v1/auth/login' || path === '/v1/auth/me') {
    return;
  }
  if (path === '/v1/auth/password' && message === CURRENT_PASSWORD_REJECTED) {
    return;
  }
  unauthorizedHandler?.();
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (text.trim() === '') {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const error = record.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).message === 'string' &&
    typeof record.requestId === 'string'
  );
}

export async function fetchReadiness(): Promise<ReadinessResponse> {
  const body = await authorizedJson('/health/ready');
  return body as ReadinessResponse;
}

export async function listTreasuries(): Promise<readonly TreasuryResource[]> {
  const body = await authorizedJson('/v1/treasuries');
  return (body as { data: readonly TreasuryResource[] }).data;
}

export async function checkTreasury(
  treasuryId: string,
): Promise<{ readonly data: TreasuryResource; readonly check: { readonly outcome: string } }> {
  const body = await authorizedJson(`/v1/treasuries/${treasuryId}/check`, {
    method: 'POST',
    body: '{}',
  });
  return body as { data: TreasuryResource; check: { outcome: string } };
}

export async function sendTestEmail(): Promise<void> {
  await authorizedJson('/v1/admin/email/test', {
    method: 'POST',
    body: '{}',
  });
}

/** C35 template names, plus `unknown` for a send that omitted kind. */
export const EMAIL_DELIVERY_KINDS = [
  'treasury_warning',
  'treasury_critical',
  'treasury_recovery',
  'treasury_unresolved_reminder',
  'treasury_finding',
  'reconciliation_failure',
  'funding_unavailable_reserve',
  'test_email',
] as const;

export const UNKNOWN_EMAIL_DELIVERY_KIND = 'unknown';

export const EMAIL_DELIVERY_KIND_FILTERS = [...EMAIL_DELIVERY_KINDS, UNKNOWN_EMAIL_DELIVERY_KIND] as const;

export type EmailDeliveryKindFilter = (typeof EMAIL_DELIVERY_KIND_FILTERS)[number];

export type EmailDeliveryStatus = 'sent' | 'failed';

/** Same page size the funding history list requests. */
export const EMAIL_DELIVERY_PAGE_LIMIT = 50;

export interface EmailDeliveryResource {
  readonly id: string;
  readonly sentAt: string;
  readonly kind: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly status: EmailDeliveryStatus;
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly correlationId: string | null;
  readonly serviceRole: string;
  readonly createdAt: string;
}

export interface EmailTriggerRow {
  readonly trigger: string;
  readonly scope: string;
  readonly condition: string;
  readonly recipients: readonly string[];
}

export interface EmailTriggersResource {
  readonly triggers: readonly EmailTriggerRow[];
  readonly recipients: readonly string[];
  readonly fromAddress: string;
  readonly provider: 'resend' | 'log-only';
}

export async function listEmailDeliveries(
  query: {
    readonly status?: EmailDeliveryStatus;
    readonly kind?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PaginatedListResponse<EmailDeliveryResource>> {
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.set('status', query.status);
  }
  if (query.kind !== undefined) {
    params.set('kind', query.kind);
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/admin/email/deliveries${suffix}`);
  return body as PaginatedListResponse<EmailDeliveryResource>;
}

export async function getEmailTriggers(): Promise<EmailTriggersResource> {
  const body = await authorizedJson('/v1/admin/email/triggers');
  if (!isRecord(body) || !isEmailTriggersResource(body.data)) {
    throw new Error('Email triggers response was not the expected shape.');
  }
  return body.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEmailTriggersResource(value: unknown): value is EmailTriggersResource {
  if (!isRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.triggers) || !value.triggers.every(isEmailTriggerRow)) {
    return false;
  }
  if (!isStringArray(value.recipients) || typeof value.fromAddress !== 'string') {
    return false;
  }
  return value.provider === 'resend' || value.provider === 'log-only';
}

function isEmailTriggerRow(value: unknown): value is EmailTriggerRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.trigger === 'string' &&
    typeof value.scope === 'string' &&
    typeof value.condition === 'string' &&
    isStringArray(value.recipients)
  );
}

export interface FundingTransactionResource {
  readonly id: string;
  readonly operation: {
    readonly id: string;
    readonly operationType: string;
    readonly status: string;
    readonly requestedBy: string;
    readonly startedAt: string;
    readonly completedAt: string | null;
  };
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  } | null;
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  } | null;
  readonly wallet: {
    readonly id: string;
    readonly role: string;
    readonly address: string;
  } | null;
  readonly destinationTreasury?: {
    readonly id: string;
    readonly kind: string;
    readonly address: string;
  } | null;
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly amountWei: string;
  readonly amountEther: string;
  readonly status: string;
  readonly transactionHash: string | null;
  readonly explorerUrl: string | null;
  readonly nonce: number | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
}

export interface FundingTransactionListResponse {
  readonly data: readonly FundingTransactionResource[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
}

export async function listFundingTransactions(
  query: {
    readonly projectId?: string;
    readonly status?: string;
    readonly operationType?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<FundingTransactionListResponse> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) {
    params.set('projectId', query.projectId);
  }
  if (query.status !== undefined) {
    params.set('status', query.status);
  }
  if (query.operationType !== undefined) {
    params.set('operationType', query.operationType);
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/funding-transactions${suffix}`);
  return body as FundingTransactionListResponse;
}

/** C19 — reconciliation run with findings inline. Findings are opaque at rest. */
export interface ReconciliationRunResource {
  readonly id: string;
  readonly runId: string;
  readonly requestedBy: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly walletsAssessed: number;
  readonly walletsFunded: number;
  readonly walletsNoop: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
  readonly weiTransferred: string;
  readonly weiTransferredEther: string;
  readonly submissionUnknownResolved: number;
  readonly submissionUnknownLeftPending: number;
  readonly unexplainedTransferCount: number;
  readonly outgoingScanStatus: 'complete' | 'incomplete' | 'not-run';
  readonly findings: readonly Record<string, unknown>[];
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
}

export async function listReconciliationRuns(
  query: {
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PaginatedListResponse<ReconciliationRunResource>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/reconciliation-runs${suffix}`);
  return body as PaginatedListResponse<ReconciliationRunResource>;
}

/** C20 — alert row including operator acknowledgement fields. */
export interface AlertResource {
  readonly id: string;
  readonly alertType: string;
  readonly severity: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly state: string;
  readonly firstTriggeredAt: string;
  readonly lastEvaluatedAt: string;
  readonly lastSentAt: string | null;
  readonly resolvedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgementNote: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function listAlerts(
  query: {
    readonly limit?: number;
    readonly offset?: number;
    readonly alertType?: string;
    readonly state?: string;
    readonly entityType?: string;
  } = {},
): Promise<PaginatedListResponse<AlertResource>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  if (query.alertType !== undefined) {
    params.set('alertType', query.alertType);
  }
  if (query.state !== undefined) {
    params.set('state', query.state);
  }
  if (query.entityType !== undefined) {
    params.set('entityType', query.entityType);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/alerts${suffix}`);
  return body as PaginatedListResponse<AlertResource>;
}

export async function acknowledgeAlert(alertId: string, note: string): Promise<AlertResource> {
  const body = await authorizedJson(`/v1/alerts/${alertId}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  return (body as { data: AlertResource }).data;
}

/**
 * C20 finding-identity acknowledgement — works whether or not an alert row
 * already exists (persist-only open + ack when creating; no email).
 */
export async function acknowledgeFinding(input: {
  readonly entityId: string;
  readonly note: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): Promise<AlertResource> {
  const body = await authorizedJson('/v1/alerts/acknowledge-finding', {
    method: 'POST',
    body: JSON.stringify({
      entityId: input.entityId,
      note: input.note,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }),
  });
  return (body as { data: AlertResource }).data;
}

export interface ProjectResource {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnvironmentResource {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FundingPolicyResource {
  readonly minimumBalanceWei: string;
  readonly targetBalanceWei: string;
  readonly maximumTopUpWei: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface ManagedWalletResource {
  readonly id: string;
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly role: string;
  readonly address: string;
  readonly explorerUrl: string;
  readonly enabled: boolean;
  readonly criticalAtStartup: boolean;
  readonly reconciliationEnabled: boolean;
  readonly policy: FundingPolicyResource | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaginatedListResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
}

async function authorizedJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const epoch = sessionEpoch;
  const headers = new Headers(init.headers);
  headers.set(SESSION_HEADER_NAME, SESSION_HEADER_VALUE);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  let body: unknown;
  try {
    body = await readResponseBody(response);
  } catch (caught) {
    if (!response.ok) {
      throw new Error(`Request failed (${String(response.status)})`, { cause: caught });
    }
    throw caught;
  }
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      const error = new ApiClientError(response.status, body);
      if (response.status === 401) {
        notifyUnauthorized(path, error.message, epoch);
      }
      throw error;
    }
    if (response.status === 401) {
      notifyUnauthorized(path, '', epoch);
    }
    throw new Error(`Request failed (${String(response.status)})`);
  }
  return body;
}

export async function listProjects(
  query: {
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PaginatedListResponse<ProjectResource>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/projects${suffix}`);
  return body as PaginatedListResponse<ProjectResource>;
}

export async function listProjectEnvironments(
  projectId: string,
  query: {
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PaginatedListResponse<EnvironmentResource>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/projects/${projectId}/environments${suffix}`);
  return body as PaginatedListResponse<EnvironmentResource>;
}

export async function setProjectEnabled(projectId: string, enabled: boolean): Promise<ProjectResource> {
  const body = await authorizedJson(`/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: ProjectResource }).data;
}

export async function getEnvironment(environmentId: string): Promise<EnvironmentResource> {
  const body = await authorizedJson(`/v1/environments/${environmentId}`);
  return (body as { data: EnvironmentResource }).data;
}

export async function setEnvironmentEnabled(
  environmentId: string,
  enabled: boolean,
): Promise<EnvironmentResource> {
  const body = await authorizedJson(`/v1/environments/${environmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: EnvironmentResource }).data;
}

export async function listWallets(
  query: {
    readonly projectId?: string;
    readonly environmentId?: string;
    readonly enabled?: boolean;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PaginatedListResponse<ManagedWalletResource>> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) {
    params.set('projectId', query.projectId);
  }
  if (query.environmentId !== undefined) {
    params.set('environmentId', query.environmentId);
  }
  // Query schema expects the strings "true" / "false" (coerceTypes is false).
  if (query.enabled !== undefined) {
    params.set('enabled', String(query.enabled));
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await authorizedJson(`/v1/wallets${suffix}`);
  return body as PaginatedListResponse<ManagedWalletResource>;
}

/**
 * Registers a managed wallet. The body is only the five confirmed fields.
 * Reconciliation and startup criticality stay at the server default (off) so
 * funding still requires a policy and an explicit reconcile enable afterwards.
 */
export interface RegisterWalletRequest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly chainId: number;
  readonly role: string;
  readonly address: string;
}

export async function registerWallet(input: RegisterWalletRequest): Promise<ManagedWalletResource> {
  const body = await authorizedJson('/v1/wallets', {
    method: 'POST',
    body: JSON.stringify({
      projectId: input.projectId,
      environmentId: input.environmentId,
      chainId: input.chainId,
      role: input.role,
      address: input.address,
    }),
  });
  return (body as { data: ManagedWalletResource }).data;
}

/** C17 — live on-chain balance. `unavailable` has no wei/ether (never treat as 0). */
export type WalletBalanceResponse =
  | {
      readonly balance: {
        readonly outcome: 'observed';
        readonly wei: string;
        readonly ether: string;
        readonly blockNumber: string;
        readonly observedAt: string;
      };
    }
  | {
      readonly balance: {
        readonly outcome: 'unavailable';
        readonly errorCode: string;
        readonly reason: string;
        readonly observedAt: string;
      };
    };

export async function getWalletBalance(walletId: string): Promise<WalletBalanceResponse> {
  const body = await authorizedJson(`/v1/wallets/${walletId}/balance`);
  return body as WalletBalanceResponse;
}

export async function setWalletEnabled(walletId: string, enabled: boolean): Promise<ManagedWalletResource> {
  const body = await authorizedJson(`/v1/wallets/${walletId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: ManagedWalletResource }).data;
}

export async function setWalletReconciliationEnabled(
  walletId: string,
  reconciliationEnabled: boolean,
): Promise<ManagedWalletResource> {
  const body = await authorizedJson(`/v1/wallets/${walletId}`, {
    method: 'PATCH',
    body: JSON.stringify({ reconciliationEnabled }),
  });
  return (body as { data: ManagedWalletResource }).data;
}

export async function setWalletPolicy(
  walletId: string,
  policy: {
    readonly minimumBalanceWei: string;
    readonly targetBalanceWei: string;
    readonly maximumTopUpWei: string;
  },
): Promise<ManagedWalletResource> {
  const body = await authorizedJson(`/v1/wallets/${walletId}/policy`, {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
  return (body as { data: ManagedWalletResource }).data;
}

export type DashboardRole = 'admin' | 'operator' | 'viewer';

export interface DashboardUserResource {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: DashboardRole;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

export interface CurrentUserResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: DashboardRole;
  };
  readonly permissions: readonly string[];
}

export interface ApiCredentialResource {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly tokenPrefix: string;
  readonly enabled: boolean;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export async function fetchCurrentUser(): Promise<CurrentUserResponse> {
  const body = await authorizedJson('/v1/auth/me');
  return body as CurrentUserResponse;
}

export async function loginWithPassword(email: string, password: string): Promise<void> {
  await authorizedJson('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logoutSession(): Promise<void> {
  await authorizedJson('/v1/auth/logout', { method: 'POST' });
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  await authorizedJson('/v1/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function listDashboardUsers(): Promise<PaginatedListResponse<DashboardUserResource>> {
  const body = await authorizedJson('/v1/admin/users?limit=50&offset=0');
  return body as PaginatedListResponse<DashboardUserResource>;
}

export async function createDashboardUser(input: {
  readonly email: string;
  readonly displayName: string;
  readonly role: DashboardRole;
  readonly password: string;
}): Promise<DashboardUserResource> {
  const body = await authorizedJson('/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return (body as { data: DashboardUserResource }).data;
}

export async function updateDashboardUser(
  userId: string,
  patch: {
    readonly enabled?: boolean;
    readonly role?: DashboardRole;
    readonly password?: string;
  },
): Promise<DashboardUserResource> {
  const body = await authorizedJson(`/v1/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return (body as { data: DashboardUserResource }).data;
}

export async function listApiCredentials(): Promise<PaginatedListResponse<ApiCredentialResource>> {
  const body = await authorizedJson('/v1/admin/credentials?limit=50&offset=0');
  return body as PaginatedListResponse<ApiCredentialResource>;
}

export async function mutateApiCredential(
  credentialId: string,
  action: 'enable' | 'disable' | 'revoke',
): Promise<ApiCredentialResource> {
  const body = await authorizedJson(`/v1/admin/credentials/${credentialId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
  return (body as { data: ApiCredentialResource }).data;
}
