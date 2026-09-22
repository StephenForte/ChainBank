import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  EMAIL_DELIVERY_KIND_FILTERS,
  SESSION_HEADER_NAME,
  SESSION_HEADER_VALUE,
  type EmailDeliveryResource,
  type EmailTriggersResource,
} from '../src/api';
import { CHAIN_FILTER_STORAGE_KEY } from '../src/chain-filter';
import { formatTimestamp } from '../src/dashboard-shared';

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
  window.location.hash = '#/email';
});

const VIEWER_PERMISSIONS = [
  'treasury:read',
  'wallet:read',
  'project:read',
  'reconciliation:read',
  'alert:read',
] as const;

const OPERATOR_PERMISSIONS = [...VIEWER_PERMISSIONS, 'email:test'] as const;

const ERROR_SUMMARY = '<img src=x onerror=alert(1)>';

describe('email page (C36)', () => {
  it('renders each trigger in API order and shows wei thresholds as ETH', async () => {
    installFetch((url) => signedInResponse('operator', OPERATOR_PERMISSIONS, url));
    render(<App />);

    expect(
      await screen.findByText(
        /Sends from chainbank@example.com via log-only to ada@example.com, ops@example.com/,
      ),
    ).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Email triggers' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Treasury balance');
    expect(rows[0]?.textContent).toContain('Ethereum Sepolia (11155111) · Public');
    expect(rows[0]?.textContent).toContain('warning 0.75 ETH; critical 0.000000000000000001 ETH');
    expect(rows[0]?.textContent).not.toContain('750000000000000000');
    expect(rows[0]?.textContent).not.toContain(' wei');
    expect(rows[1]?.textContent).toContain('Test email');
    expect(rows[1]?.textContent).toContain('Sent when an operator requests a test message');
  });

  it('renders the delivery log newest first, with a failed pill and text-only detail', async () => {
    installFetch((url) => {
      if (url.includes('/v1/admin/email/deliveries')) {
        return jsonResponse(200, deliveryPage([failedDelivery(), sentDelivery()], 60));
      }
      return signedInResponse('operator', OPERATOR_PERMISSIONS, url);
    });
    render(<App />);

    const table = await screen.findByRole('table', { name: 'Email deliveries' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('treasury_finding');
    expect(rows[0]?.textContent).toContain(formatTimestamp(failedDelivery().sentAt));
    expect(rows[1]?.textContent).toContain('test_email');
    const failedPill = rows[0]?.querySelector('.badge');
    expect(failedPill?.className).toBe('badge badge-bad');
    expect(failedPill?.textContent).toBe('failed');
    const sentPill = rows[1]?.querySelector('.badge');
    expect(sentPill?.className).toBe('badge badge-ok');
    expect(sentPill?.textContent).toBe('sent');
    expect(rows[1]?.textContent).toContain('<b>Test</b>');
    expect(rows[1]?.querySelector('b')).toBeNull();

    const detailButtons = screen.getAllByRole('button', { name: 'Details' });
    const firstDetail = detailButtons[0];
    expect(firstDetail).toBeTruthy();
    fireEvent.click(firstDetail as HTMLElement);

    const summary = await screen.findByText(ERROR_SUMMARY);
    expect(summary.tagName).toBe('DD');
    expect(summary.childElementCount).toBe(0);
    expect(summary.querySelector('*')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('msg_123')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
  });

  it('sends status and kind filters, and the next page offset, as query parameters', async () => {
    const fetchMock = installFetch((url) => {
      if (url.includes('/v1/admin/email/deliveries')) {
        return jsonResponse(200, deliveryPage([failedDelivery()], 60));
      }
      return signedInResponse('operator', OPERATOR_PERMISSIONS, url);
    });
    render(<App />);

    await screen.findByRole('table', { name: 'Email deliveries' });
    const first = latestDeliveriesUrl(fetchMock);
    expect(first).toContain('limit=50');
    expect(first).toContain('offset=0');
    expect(first).not.toContain('status=');
    expect(first).not.toContain('kind=');

    const kind = screen.getByLabelText('Kind');
    for (const value of EMAIL_DELIVERY_KIND_FILTERS) {
      expect(within(kind).getByRole('option', { name: value })).toBeTruthy();
    }
    expect(within(screen.getByLabelText('Status')).getByRole('option', { name: 'All' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => {
      expect(latestDeliveriesUrl(fetchMock)).toContain('status=failed');
    });
    expect(latestDeliveriesUrl(fetchMock)).not.toContain('kind=');

    fireEvent.change(kind, { target: { value: 'unknown' } });
    await waitFor(() => {
      const url = latestDeliveriesUrl(fetchMock);
      expect(url).toContain('status=failed');
      expect(url).toContain('kind=unknown');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(latestDeliveriesUrl(fetchMock)).toContain('offset=50');
    });
    const paged = latestDeliveriesUrl(fetchMock);
    expect(paged).toContain('status=failed');
    expect(paged).toContain('kind=unknown');
  });

  it('uses the empty-log sentence when total is 0 and the filter sentence otherwise', async () => {
    installFetch((url) => {
      if (url.includes('/v1/admin/email/deliveries')) {
        return jsonResponse(200, deliveryPage([], 0));
      }
      return signedInResponse('viewer', VIEWER_PERMISSIONS, url);
    });
    const first = render(<App />);
    expect(await screen.findByText('No emails have been sent yet')).toBeTruthy();
    expect(screen.queryByText('No deliveries match these filters')).toBeNull();
    first.unmount();

    installFetch((url) => {
      if (url.includes('/v1/admin/email/deliveries')) {
        return jsonResponse(200, deliveryPage([], 4));
      }
      return signedInResponse('viewer', VIEWER_PERMISSIONS, url);
    });
    render(<App />);
    expect(await screen.findByText('No deliveries match these filters')).toBeTruthy();
    expect(screen.queryByText('No emails have been sent yet')).toBeNull();
  });

  it('keeps Send test email off the top bar, gates it on email:test, and reloads after a send', async () => {
    installFetch((url) => signedInResponse('viewer', VIEWER_PERMISSIONS, url));
    const viewer = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Delivery log' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send test email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test email' })).toBeNull();
    expect(within(topBar()).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(within(topBar()).queryByRole('button', { name: 'Send test email' })).toBeNull();
    viewer.unmount();

    let deliveryReads = 0;
    installFetch((url, init) => {
      if (url.includes('/v1/admin/email/test') && init?.method === 'POST') {
        return jsonResponse(200, { data: { delivered: true } });
      }
      if (url.includes('/v1/admin/email/deliveries')) {
        deliveryReads += 1;
        const row = deliveryReads === 1 ? failedDelivery() : sentDelivery();
        return jsonResponse(200, deliveryPage([row], 1));
      }
      return signedInResponse('operator', OPERATOR_PERMISSIONS, url);
    });
    render(<App />);

    const beforeTable = await screen.findByRole('table', { name: 'Email deliveries' });
    expect(within(beforeTable).getByText('treasury_finding')).toBeTruthy();
    expect(within(beforeTable).queryByText('test_email')).toBeNull();
    const before = deliveryReads;
    expect(screen.queryByRole('button', { name: 'Test email' })).toBeNull();
    expect(within(topBar()).queryByRole('button', { name: 'Send test email' })).toBeNull();
    expect(within(topBar()).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));

    await waitFor(() => {
      expect(deliveryReads).toBe(before + 1);
    });
    const afterTable = await screen.findByRole('table', { name: 'Email deliveries' });
    expect(within(afterTable).getByText('test_email')).toBeTruthy();
  });

  it('sends the session header on both email calls and ignores the chain filter', async () => {
    window.localStorage.setItem(CHAIN_FILTER_STORAGE_KEY, '11155111');
    const fetchMock = installFetch((url, init) => {
      if (url.includes('/v1/treasuries')) {
        return jsonResponse(200, { data: [treasury()] });
      }
      return signedInResponse('operator', OPERATOR_PERMISSIONS, url, init);
    });
    render(<App />);

    const table = await screen.findByRole('table', { name: 'Email deliveries' });
    expect(within(table).getByText('treasury_finding')).toBeTruthy();
    expect(within(table).getByText('test_email')).toBeTruthy();
    await screen.findByRole('button', { name: /Ethereum Sepolia/ });

    for (const path of ['/v1/admin/email/triggers', '/v1/admin/email/deliveries']) {
      const call = fetchMock.mock.calls.find((item) => requestUrl(item[0]).includes(path));
      expect(call, path).toBeTruthy();
      const headers = new Headers(call?.[1]?.headers);
      expect(headers.get(SESSION_HEADER_NAME)).toBe(SESSION_HEADER_VALUE);
      expect(headers.has('Authorization')).toBe(false);
      expect(call?.[1]?.credentials).toBe('same-origin');
      const url = requestUrl(call?.[0] ?? '');
      expect(url).not.toContain('chainId');
      expect(url).not.toContain('11155111');
    }

    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    expect(fetchMock.mock.calls.length).toBe(before);
    const still = screen.getByRole('table', { name: 'Email deliveries' });
    expect(within(still).getByText('treasury_finding')).toBeTruthy();
    expect(within(still).getByText('test_email')).toBeTruthy();
  });

  it('shows a triggers error without hiding the delivery log', async () => {
    installFetch((url) => {
      if (url.includes('/v1/admin/email/triggers')) {
        return jsonResponse(500, {
          error: { code: 'INTERNAL', message: 'triggers down' },
          requestId: 'req-triggers',
        });
      }
      return signedInResponse('viewer', VIEWER_PERMISSIONS, url);
    });
    render(<App />);

    expect(await screen.findByText('INTERNAL: triggers down (req-triggers)')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Email deliveries' });
    expect(within(table).getByText('treasury_finding')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Triggers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delivery log' })).toBeTruthy();
  });
});

function topBar(): HTMLElement {
  const heading = screen.getByRole('heading', { level: 1, name: 'Email' });
  const header = heading.closest('header');
  if (header === null) {
    throw new Error('Email heading is not in the top bar');
  }
  return header;
}

function installFetch(
  respond: (url: string, init: RequestInit | undefined) => Response,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    return Promise.resolve(respond(url, init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function latestDeliveriesUrl(fetchMock: {
  mock: { calls: readonly (readonly [RequestInfo | URL, ...unknown[]])[] };
}): string {
  const urls = fetchMock.mock.calls
    .map((call) => requestUrl(call[0]))
    .filter((url) => url.includes('/v1/admin/email/deliveries'));
  const latest = urls[urls.length - 1];
  if (latest === undefined) {
    throw new Error('No deliveries request was recorded');
  }
  return latest;
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
  role: 'operator' | 'viewer',
  permissions: readonly string[],
  url = '/v1/auth/me',
  init?: RequestInit,
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
  if (url.includes('/v1/admin/email/triggers')) {
    return jsonResponse(200, { data: triggers() });
  }
  if (url.includes('/v1/admin/email/deliveries')) {
    return jsonResponse(200, deliveryPage([failedDelivery(), sentDelivery()], 2));
  }
  if (url.includes('/v1/admin/email/test') && init?.method === 'POST') {
    return jsonResponse(200, { data: { delivered: true } });
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
    return jsonResponse(200, { data: [] });
  }
  return jsonResponse(200, { data: [], pagination: { limit: 50, offset: 0, total: 0 } });
}

function triggers(): EmailTriggersResource {
  return {
    triggers: [
      {
        trigger: 'Treasury balance',
        scope: 'Ethereum Sepolia (11155111) · Public · 0xabc',
        condition: 'warning 750000000000000000 wei; critical 1 wei',
        recipients: ['ada@example.com', 'ops@example.com'],
      },
      {
        trigger: 'Test email',
        scope: 'On demand',
        condition: 'Sent when an operator requests a test message',
        recipients: ['ada@example.com', 'ops@example.com'],
      },
    ],
    recipients: ['ada@example.com', 'ops@example.com'],
    fromAddress: 'chainbank@example.com',
    provider: 'log-only',
  };
}

function deliveryPage(
  data: readonly EmailDeliveryResource[],
  total: number,
): {
  readonly data: readonly EmailDeliveryResource[];
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number };
} {
  return { data, pagination: { limit: 50, offset: 0, total } };
}

function failedDelivery(): EmailDeliveryResource {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    sentAt: '2026-09-22T18:00:00.000Z',
    kind: 'treasury_finding',
    recipients: ['ada@example.com'],
    subject: 'Critical finding',
    status: 'failed',
    providerMessageId: 'msg_123',
    errorCode: 'EMAIL_PROVIDER_REJECTED',
    errorSummary: ERROR_SUMMARY,
    relatedEntityType: 'treasury',
    relatedEntityId: 'treasury-1',
    correlationId: 'corr-1',
    serviceRole: 'treasury-monitor',
    createdAt: '2026-09-22T18:00:01.000Z',
  };
}

function sentDelivery(): EmailDeliveryResource {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    sentAt: '2026-09-22T12:00:00.000Z',
    kind: 'test_email',
    recipients: ['ada@example.com', 'ops@example.com'],
    subject: '<b>Test</b>',
    status: 'sent',
    providerMessageId: null,
    errorCode: null,
    errorSummary: null,
    relatedEntityType: null,
    relatedEntityId: null,
    correlationId: null,
    serviceRole: 'web',
    createdAt: '2026-09-22T12:00:01.000Z',
  };
}

function treasury(): Record<string, unknown> {
  return {
    id: 'treasury-1',
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
    balance: { wei: '1', ether: '0.000000000000000001', observedAt: null },
    spendable: { wei: '1', ether: '0.000000000000000001' },
    thresholds: {
      warningEther: '0.75',
      criticalEther: '0.3',
      recoveryEther: '1.5',
      minimumReserveEther: '0.1',
    },
    lastCheckedAt: null,
    lastCheckErrorCode: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
