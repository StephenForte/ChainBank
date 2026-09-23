import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { App } from '../src/App';
import type { DashboardRole } from '../src/api';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const LOWER_ADDRESS = '0x0c4667ef97b39599b9aca980d3b6465ce6cf2568';
const CHECKSUMMED_ADDRESS = getAddress(LOWER_ADDRESS);

const VIEWER_PERMISSIONS = ['treasury:read', 'wallet:read', 'project:read'] as const;
const OPERATOR_PERMISSIONS = [...VIEWER_PERMISSIONS, 'wallet:write'] as const;

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

describe('add wallet page (TX.44)', () => {
  it('shows Add wallet directly under Wallets for an admin', async () => {
    installFetch('admin', [...OPERATOR_PERMISSIONS, 'user:manage']);
    render(<App />);

    expect(await screen.findByRole('link', { name: 'Add wallet' })).toBeTruthy();
    expect(navLabels()[navLabels().indexOf('Wallets') + 1]).toBe('Add wallet');
    expect(screen.getByRole('link', { name: 'Add wallet' }).getAttribute('href')).toBe('#/add-wallet');
  });

  it('shows Add wallet directly under Wallets for an operator', async () => {
    installFetch('operator', OPERATOR_PERMISSIONS);
    render(<App />);

    expect(await screen.findByRole('link', { name: 'Add wallet' })).toBeTruthy();
    expect(navLabels()[navLabels().indexOf('Wallets') + 1]).toBe('Add wallet');
  });

  it('hides Add wallet from a viewer, including when the route is opened directly', async () => {
    installFetch('viewer', VIEWER_PERMISSIONS);
    window.location.hash = '#/add-wallet';
    render(<App />);

    expect(await screen.findByText('You do not have permission to add a wallet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add wallet' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Register a wallet' })).toBeNull();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review registration' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Register wallet' })).toBeNull();
  });

  it('keeps the register form off the Wallets page and mounts it on Add wallet', async () => {
    installFetch('operator', OPERATOR_PERMISSIONS);
    window.location.hash = '#/wallets';
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Managed wallets' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Register a wallet' })).toBeNull();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review registration' })).toBeNull();

    window.location.hash = '#/add-wallet';
    fireEvent(window, new HashChangeEvent('hashchange'));

    expect(await screen.findByRole('heading', { level: 2, name: 'Register a wallet' })).toBeTruthy();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review registration' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Managed wallets' })).toBeNull();
  });

  it('lands on #/wallets after a successful registration', async () => {
    const fetchMock = installFetch('operator', OPERATOR_PERMISSIONS);
    window.location.hash = '#/add-wallet';
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Register a wallet' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'development' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Base Sepolia (84532)' })).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: ENVIRONMENT_ID } });
    fireEvent.change(screen.getByLabelText('Chain', { selector: 'select' }), { target: { value: '84532' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'happy-meal' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: LOWER_ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register wallet' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/wallets');
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Wallets' })).toBeTruthy();
    expect(screen.getByText('Wallet registered. Set a policy, then enable auto-funding.')).toBeTruthy();

    const post = fetchMock.mock.calls.find((call) => {
      const url = requestUrl(call[0]);
      return url.includes('/v1/wallets') && call[1]?.method === 'POST';
    });
    expect(post).toBeTruthy();
    const rawBody = post?.[1]?.body;
    if (typeof rawBody !== 'string') {
      throw new Error('registration POST body was not a string');
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['address', 'chainId', 'environmentId', 'projectId', 'role']);
    expect(body).toEqual({
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      chainId: 84_532,
      role: 'happy-meal',
      address: CHECKSUMMED_ADDRESS,
    });
    expect(body).not.toHaveProperty('reconciliationEnabled');
  });
});

function navLabels(): string[] {
  const nav = screen.getByRole('navigation', { name: 'Pages' });
  return Array.from(nav.querySelectorAll('a')).map(
    (anchor) => anchor.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

function installFetch(
  role: DashboardRole,
  permissions: readonly string[],
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(respond(requestUrl(input), init, role, permissions));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function respond(
  url: string,
  init: RequestInit | undefined,
  role: DashboardRole,
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
      checkedAt: '2026-09-23T00:00:00.000Z',
      components: [],
      heartbeats: [],
    });
  }
  if (url.includes('/v1/treasuries')) {
    return jsonResponse(200, { data: [treasury()] });
  }
  if (url.includes('/v1/projects') && url.includes('/environments')) {
    return jsonResponse(200, {
      data: [
        {
          id: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          slug: 'development',
          name: 'Development',
          enabled: true,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      ],
      pagination: { limit: 100, offset: 0, total: 1 },
    });
  }
  if (url.includes('/v1/projects')) {
    return jsonResponse(200, {
      data: [
        {
          id: PROJECT_ID,
          slug: 'fortel2',
          name: 'Fortel2',
          enabled: true,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      ],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
  }
  if (url.includes('/v1/wallets') && init?.method === 'POST') {
    return jsonResponse(201, { data: registeredWallet() });
  }
  return jsonResponse(200, { data: [], pagination: { limit: 50, offset: 0, total: 0 } });
}

function treasury(): Record<string, unknown> {
  return {
    id: 'treasury-base',
    kind: 'operational',
    displayKind: 'Private',
    status: 'healthy',
    enabled: true,
    address: '0x512800000000000000000000000000000000652d',
    explorerUrl: 'https://sepolia.basescan.org/address/0x512800000000000000000000000000000000652d',
    chain: {
      slug: 'base-sepolia',
      chainId: 84_532,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
    },
    balance: { wei: '1000000000000000000', ether: '1', observedAt: '2026-09-23T00:00:00.000Z' },
    spendable: { wei: '1000000000000000000', ether: '1' },
    thresholds: {
      warningEther: '0.5',
      criticalEther: '0.1',
      recoveryEther: '2',
      minimumReserveEther: '0.1',
    },
    lastCheckedAt: '2026-09-23T00:00:00.000Z',
    lastCheckErrorCode: null,
  };
}

function registeredWallet(): Record<string, unknown> {
  return {
    id: 'wallet-happy-meal',
    project: { id: PROJECT_ID, slug: 'fortel2', name: 'Fortel2', enabled: true },
    environment: { id: ENVIRONMENT_ID, slug: 'development', name: 'Development', enabled: true },
    chain: {
      slug: 'base-sepolia',
      chainId: 84_532,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
    },
    role: 'happy-meal',
    address: CHECKSUMMED_ADDRESS,
    explorerUrl: `https://sepolia.basescan.org/address/${CHECKSUMMED_ADDRESS}`,
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: false,
    policy: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
