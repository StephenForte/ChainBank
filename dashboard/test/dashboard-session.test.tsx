import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SESSION_HEADER_NAME, SESSION_HEADER_VALUE } from '../src/api';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = '';
});

const VIEWER_PERMISSIONS = [
  'treasury:read',
  'wallet:read',
  'project:read',
  'reconciliation:read',
  'alert:read',
] as const;

const OPERATOR_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  'treasury:check',
  'treasury:write',
  'email:test',
  'wallet:write',
  'project:write',
  'credential:read',
  'credential:write',
  'alert:acknowledge',
] as const;

describe('dashboard session (C33)', () => {
  it('renders the login page and issues no other fetch when me is 401', async () => {
    const fetchMock = installFetch(() =>
      jsonResponse(401, errorBody('The supplied credential is not valid.')),
    );
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0]));
    expect(urls.every((url) => url.includes('/v1/auth/me'))).toBe(true);
    expect(urls.some((url) => url.includes('/v1/treasuries'))).toBe(false);
  });

  it('renders the shell after me succeeds and sends the session header on later calls', async () => {
    const fetchMock = installFetch((url) =>
      signedInResponse(url, 'admin', [...OPERATOR_PERMISSIONS, 'user:manage']),
    );
    render(<App />);

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();

    await waitFor(() => {
      expect(urlsOf(fetchMock).some((url) => url.includes('/v1/treasuries'))).toBe(true);
    });

    const sampled = ['/health/ready', '/v1/treasuries', '/v1/projects'].map((path) => {
      const call = fetchMock.mock.calls.find((item) => requestUrl(item[0]).includes(path));
      expect(call, path).toBeTruthy();
      return call?.[1];
    });
    for (const init of sampled) {
      const headers = new Headers(init?.headers);
      expect(headers.get(SESSION_HEADER_NAME)).toBe(SESSION_HEADER_VALUE);
      expect(headers.has('Authorization')).toBe(false);
      expect(init?.credentials).toBe('same-origin');
    }
  });

  it('returns to login on a mid-session 401, keeps the hash, and restores that route', async () => {
    window.location.hash = '#/wallets';
    let expired = false;
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/v1/auth/login') && init?.method === 'POST') {
        expired = false;
        return emptyResponse(204);
      }
      if (expired && !url.includes('/v1/auth/login')) {
        return jsonResponse(401, errorBody('The supplied credential is not valid.'));
      }
      return signedInResponse(url, 'operator', OPERATOR_PERMISSIONS);
    });
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Wallets' })).toBeTruthy();
    expired = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Your session ended, sign in again')).toBeTruthy();
    expect(window.location.hash).toBe('#/wallets');
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Wallets' })).toBeTruthy();
    expect(window.location.hash).toBe('#/wallets');
    expect(urlsOf(fetchMock).some((url) => url.includes('/v1/auth/login'))).toBe(true);
  });

  it('shows Admin only for an admin, and hides actions a viewer lacks', async () => {
    installFetch((url) => signedInResponse(url, 'viewer', VIEWER_PERMISSIONS));
    window.location.hash = '#/overview';
    render(<App />);

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('viewer')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test email' })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 3, name: /Public · Ethereum Sepolia/ })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();

    window.location.hash = '#/admin';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByText('Admin is available to administrators')).toBeTruthy();

    window.location.hash = '#/alerts';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByText('unexplained_outgoing_transfer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledging…' })).toBeNull();
  });

  it('logs out through the session endpoint and shows the login page', async () => {
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/v1/auth/logout') && init?.method === 'POST') {
        return emptyResponse(204);
      }
      return signedInResponse(url, 'operator', OPERATOR_PERMISSIONS);
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Log out' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    const logout = fetchMock.mock.calls.find((call) => requestUrl(call[0]).includes('/v1/auth/logout'));
    expect(logout).toBeTruthy();
    expect(new Headers(logout?.[1]?.headers).get(SESSION_HEADER_NAME)).toBe(SESSION_HEADER_VALUE);
    expect(logout?.[1]?.credentials).toBe('same-origin');
  });

  it('does not sign out the next session when a request from the previous one returns 401', async () => {
    let releaseStale: ((response: Response) => void) | undefined;
    let held = false;
    installFetch((url, init) => {
      if (url.includes('/v1/auth/login') && init?.method === 'POST') {
        return emptyResponse(204);
      }
      if (url.includes('/v1/auth/logout') && init?.method === 'POST') {
        return emptyResponse(204);
      }
      if (url.includes('/v1/treasuries') && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseStale = resolve;
        });
      }
      return signedInResponse(url, 'admin', [...OPERATOR_PERMISSIONS, 'user:manage']);
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Log out' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();

    const release = releaseStale;
    expect(release).toBeTypeOf('function');
    release?.(jsonResponse(401, errorBody('The supplied credential is not valid.')));

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    });
    expect(screen.queryByText('Your session ended, sign in again')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('drops a previous account error when the next user signs in', async () => {
    installFetch((url, init) => {
      if (url.includes('/v1/auth/login') && init?.method === 'POST') {
        return emptyResponse(204);
      }
      if (url.includes('/v1/auth/logout') && init?.method === 'POST') {
        return emptyResponse(204);
      }
      if (url.includes('/v1/admin/email/test')) {
        return jsonResponse(500, errorBody('inbox down'));
      }
      return signedInResponse(url, 'admin', [...OPERATOR_PERMISSIONS, 'user:manage']);
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Test email' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test email' }));
    expect(await screen.findByText('INVALID_CREDENTIAL: inbox down (req-test)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.queryByText('INVALID_CREDENTIAL: inbox down (req-test)')).toBeNull();
  });
});

function installFetch(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    return Promise.resolve(respond(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function urlsOf(fetchMock: {
  mock: { calls: readonly (readonly [RequestInfo | URL, ...unknown[]])[] };
}): string[] {
  return fetchMock.mock.calls.map((call) => requestUrl(call[0]));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function signedInResponse(
  url: string,
  role: 'admin' | 'operator' | 'viewer',
  permissions: readonly string[],
): Response {
  if (url.includes('/v1/auth/me')) {
    return jsonResponse(200, {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        role,
      },
      permissions,
    });
  }
  if (url.includes('/health/ready')) {
    return jsonResponse(200, {
      status: 'ok',
      checkedAt: '2026-09-22T00:00:00.000Z',
      components: [],
      heartbeats: [],
    });
  }
  if (url.includes('/v1/treasuries')) {
    return jsonResponse(200, { data: [treasury()] });
  }
  if (url.includes('/v1/alerts')) {
    const acknowledged = url.includes('state=acknowledged');
    return jsonResponse(200, {
      data: acknowledged ? [] : [openAlert()],
      pagination: { limit: 50, offset: 0, total: acknowledged ? 0 : 1 },
    });
  }
  if (url.includes('/v1/reconciliation-runs')) {
    return jsonResponse(200, {
      data: [reconciliationRun()],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
  }
  return jsonResponse(200, { data: [], pagination: { limit: 50, offset: 0, total: 0 } });
}

function treasury(): Record<string, unknown> {
  return {
    id: 'treasury-card-1',
    kind: 'external',
    displayKind: 'Public',
    status: 'healthy',
    enabled: true,
    address: '0x1111111111111111111111111111111111111111',
    explorerUrl: 'https://sepolia.etherscan.io/address/0x1111111111111111111111111111111111111111',
    chain: {
      slug: 'ethereum-sepolia',
      chainId: 11_155_111,
      displayName: 'Ethereum Sepolia',
      nativeSymbol: 'ETH',
    },
    balance: { wei: '1250000000000000000', ether: '1.25', observedAt: '2026-09-22T00:00:00.000Z' },
    spendable: { wei: '800000000000000000', ether: '0.8' },
    thresholds: {
      warningEther: '0.75',
      criticalEther: '0.3',
      recoveryEther: '1.5',
      minimumReserveEther: '0.1',
    },
    lastCheckedAt: '2026-09-22T00:00:00.000Z',
    lastCheckErrorCode: null,
  };
}

function openAlert(): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    alertType: 'treasury_finding',
    severity: 'critical',
    entityType: 'treasury',
    entityId: `0x${'ab'.repeat(32)}`,
    state: 'open',
    firstTriggeredAt: '2026-09-22T06:00:00.000Z',
    lastEvaluatedAt: '2026-09-22T06:00:00.000Z',
    lastSentAt: null,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    metadata: {},
  };
}

function reconciliationRun(): Record<string, unknown> {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    runId: 'run-critical',
    requestedBy: 'cron',
    startedAt: '2026-09-22T06:00:00.000Z',
    finishedAt: '2026-09-22T06:00:20.000Z',
    walletsAssessed: 1,
    walletsFunded: 0,
    walletsNoop: 1,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: '0',
    weiTransferredEther: '0',
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: 1,
    outgoingScanStatus: 'complete',
    findings: [
      {
        severity: 'critical',
        kind: 'unexplained_outgoing_transfer',
        treasuryId: 'treasury-card-1',
        transactionHash: `0x${'ab'.repeat(32)}`,
        valueWei: '1000000000000000000',
      },
    ],
    errorCode: null,
    errorSummary: null,
  };
}

function errorBody(message: string): unknown {
  return { error: { code: 'INVALID_CREDENTIAL', message }, requestId: 'req-test' };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}
