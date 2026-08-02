export type TreasuryStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface TreasuryResource {
  readonly id: string;
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

async function parseJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
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
  const response = await fetch('/health/ready');
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Readiness check failed (${String(response.status)})`);
  }
  return body as ReadinessResponse;
}

export async function listTreasuries(token: string): Promise<readonly TreasuryResource[]> {
  const response = await fetch('/v1/treasuries', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Failed to list treasuries (${String(response.status)})`);
  }
  return (body as { data: readonly TreasuryResource[] }).data;
}

export async function checkTreasury(
  token: string,
  treasuryId: string,
): Promise<{ readonly data: TreasuryResource; readonly check: { readonly outcome: string } }> {
  const response = await fetch(`/v1/treasuries/${treasuryId}/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Treasury check failed (${String(response.status)})`);
  }
  return body as { data: TreasuryResource; check: { outcome: string } };
}

export async function sendTestEmail(token: string): Promise<void> {
  const response = await fetch('/v1/admin/email/test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Test email failed (${String(response.status)})`);
  }
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
  };
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly wallet: {
    readonly id: string;
    readonly role: string;
    readonly address: string;
  };
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
  token: string,
  query: {
    readonly projectId?: string;
    readonly status?: string;
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
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.offset !== undefined) {
    params.set('offset', String(query.offset));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetch(`/v1/funding-transactions${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Failed to list funding transactions (${String(response.status)})`);
  }
  return body as FundingTransactionListResponse;
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

async function authorizedJson(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  const body: unknown = await parseJson(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(response.status, body);
    }
    throw new Error(`Request failed (${String(response.status)})`);
  }
  return body;
}

export async function listProjects(
  token: string,
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
  const body = await authorizedJson(token, `/v1/projects${suffix}`);
  return body as PaginatedListResponse<ProjectResource>;
}

export async function listProjectEnvironments(
  token: string,
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
  const body = await authorizedJson(token, `/v1/projects/${projectId}/environments${suffix}`);
  return body as PaginatedListResponse<EnvironmentResource>;
}

export async function setProjectEnabled(
  token: string,
  projectId: string,
  enabled: boolean,
): Promise<ProjectResource> {
  const body = await authorizedJson(token, `/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: ProjectResource }).data;
}

export async function getEnvironment(token: string, environmentId: string): Promise<EnvironmentResource> {
  const body = await authorizedJson(token, `/v1/environments/${environmentId}`);
  return (body as { data: EnvironmentResource }).data;
}

export async function setEnvironmentEnabled(
  token: string,
  environmentId: string,
  enabled: boolean,
): Promise<EnvironmentResource> {
  const body = await authorizedJson(token, `/v1/environments/${environmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: EnvironmentResource }).data;
}

export async function listWallets(
  token: string,
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
  const body = await authorizedJson(token, `/v1/wallets${suffix}`);
  return body as PaginatedListResponse<ManagedWalletResource>;
}

export async function setWalletEnabled(
  token: string,
  walletId: string,
  enabled: boolean,
): Promise<ManagedWalletResource> {
  const body = await authorizedJson(token, `/v1/wallets/${walletId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return (body as { data: ManagedWalletResource }).data;
}

export async function setWalletReconciliationEnabled(
  token: string,
  walletId: string,
  reconciliationEnabled: boolean,
): Promise<ManagedWalletResource> {
  const body = await authorizedJson(token, `/v1/wallets/${walletId}`, {
    method: 'PATCH',
    body: JSON.stringify({ reconciliationEnabled }),
  });
  return (body as { data: ManagedWalletResource }).data;
}

export async function setWalletPolicy(
  token: string,
  walletId: string,
  policy: {
    readonly minimumBalanceWei: string;
    readonly targetBalanceWei: string;
    readonly maximumTopUpWei: string;
  },
): Promise<ManagedWalletResource> {
  const body = await authorizedJson(token, `/v1/wallets/${walletId}/policy`, {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
  return (body as { data: ManagedWalletResource }).data;
}
