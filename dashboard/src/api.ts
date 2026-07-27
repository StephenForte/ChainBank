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
