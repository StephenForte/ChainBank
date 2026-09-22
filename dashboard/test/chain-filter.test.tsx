import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { App } from '../src/App';
import {
  ALL_CHAINS,
  attentionByChain,
  ChainFilterControl,
  CHAIN_FILTER_STORAGE_KEY,
  useChainFilter,
  type ChainSegment,
} from '../src/chain-filter';
import { formatTimestamp } from '../src/dashboard-shared';
import { OverviewPage, type OverviewPageProps } from '../src/pages/overview';
import { ServiceReadinessPanel } from '../src/pages/panels/service-readiness-panel';
import type {
  FundingTransactionResource,
  ManagedWalletResource,
  ReconciliationRunResource,
  TreasuryResource,
} from '../src/api';

const SEPOLIA = 11_155_111;
const BASE = 84_532;
const DEV = 1;
const TX_HASH = `0x${'ab'.repeat(32)}`;

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
  window.location.hash = '#/overview';
});

describe('chain filter (C34)', () => {
  it('renders ALL then each treasury chain by descending chainId, and a third chain with no extra segment list', () => {
    const { rerender } = render(<FilterProbe treasuries={twoTreasuries()} />);

    expect(segmentLabels()).toEqual(['ALL', 'Ethereum Sepolia', 'Base Sepolia']);

    rerender(
      <FilterProbe
        treasuries={[
          ...twoTreasuries(),
          treasury({
            id: 'treasury-dev',
            chainId: DEV,
            displayName: 'Dev Chain',
            status: 'healthy',
          }),
        ]}
      />,
    );

    expect(segmentLabels()).toEqual(['ALL', 'Ethereum Sepolia', 'Base Sepolia', 'Dev Chain']);
  });

  it('remembers the selection across a remount and falls back to ALL for an unknown stored id', () => {
    const first = render(<FilterProbe treasuries={twoTreasuries()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Base Sepolia' }));
    expect(window.localStorage.getItem(CHAIN_FILTER_STORAGE_KEY)).toBe(String(BASE));
    expect(screen.getByRole('button', { name: 'Base Sepolia' }).getAttribute('aria-pressed')).toBe('true');

    first.unmount();
    render(<FilterProbe treasuries={twoTreasuries()} />);
    expect(screen.getByRole('button', { name: 'Base Sepolia' }).getAttribute('aria-pressed')).toBe('true');

    cleanup();
    window.localStorage.setItem(CHAIN_FILTER_STORAGE_KEY, '999');
    render(<FilterProbe treasuries={twoTreasuries()} />);
    expect(screen.getByRole('button', { name: 'ALL' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Base Sepolia' }).getAttribute('aria-pressed')).toBe('false');

    cleanup();
    window.localStorage.setItem(CHAIN_FILTER_STORAGE_KEY, 'not-a-chain');
    render(<FilterProbe treasuries={twoTreasuries()} />);
    expect(screen.getByRole('button', { name: 'ALL' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('computes the four overview counts from the fixture and links each card', () => {
    render(<OverviewPage {...overviewProps()} visibleChainIds={[SEPOLIA]} />);

    const health = screen.getByRole('link', { name: /Treasury health/ });
    expect(health.getAttribute('href')).toBe('#/treasuries');
    expect(health.textContent).toContain('1 healthy · 1 warning · 0 critical');

    const wallets = screen.getByRole('link', { name: /Wallets needing attention/ });
    expect(wallets.getAttribute('href')).toBe('#/wallets');
    expect(wallets.textContent).toContain('2');
    expect(wallets.textContent).not.toContain('3');

    const alerts = screen.getByRole('link', { name: /Open alerts/ });
    expect(alerts.getAttribute('href')).toBe('#/alerts');
    expect(alerts.textContent).toContain('2');
    expect(alerts.textContent).toContain('all chains');

    const run = screen.getByRole('link', { name: /Last reconciler run/ });
    expect(run.getAttribute('href')).toBe('#/reconciliation');
    expect(run.textContent).toContain('finished');
    expect(run.textContent).toContain(formatTimestamp('2026-09-22T06:00:20.000Z'));
  });

  it('counts every visible treasury status and every wallet that needs attention when ALL is selected', () => {
    render(<OverviewPage {...overviewProps()} visibleChainIds={ALL_CHAINS} />);

    expect(screen.getByRole('link', { name: /Treasury health/ }).textContent).toContain(
      '1 healthy · 1 warning · 1 critical',
    );
    expect(screen.getByRole('link', { name: /Wallets needing attention/ }).textContent).toMatch(/3/);
  });

  it('hides a readiness row that names another chain and keeps rows that name none', () => {
    render(
      <ServiceReadinessPanel
        loadReadiness={() => Promise.resolve()}
        readinessState="ready"
        readinessError={undefined}
        chains={segments()}
        visibleChainIds={[SEPOLIA]}
        readiness={{
          status: 'degraded',
          checkedAt: '2026-09-22T00:00:00.000Z',
          components: [
            { name: 'database', status: 'ok', detail: null },
            {
              name: 'rpc',
              status: 'failed',
              detail: 'The RPC endpoint reports chain 84532.',
            },
          ],
          heartbeats: [
            { serviceRole: 'wallet-reconciler', lastSeenAt: '2026-09-22T00:00:00.000Z' },
            { serviceRole: 'monitor Base Sepolia', lastSeenAt: '2026-09-22T00:00:00.000Z' },
          ],
        }}
      />,
    );

    expect(screen.getByText('database')).toBeTruthy();
    expect(screen.queryByText('rpc')).toBeNull();
    expect(screen.queryByText(/84532/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Heartbeats and component detail/ }));
    expect(screen.getByText('wallet-reconciler')).toBeTruthy();
    expect(screen.queryByText('monitor Base Sepolia')).toBeNull();
    expect(screen.queryByText('No heartbeats recorded yet.')).toBeNull();
  });

  it('does not describe a filtered-out heartbeat as never recorded', () => {
    render(
      <ServiceReadinessPanel
        loadReadiness={() => Promise.resolve()}
        readinessState="ready"
        readinessError={undefined}
        chains={segments()}
        visibleChainIds={[SEPOLIA]}
        readiness={{
          status: 'degraded',
          checkedAt: '2026-09-22T00:00:00.000Z',
          components: [{ name: 'database', status: 'ok', detail: null }],
          heartbeats: [{ serviceRole: 'monitor Base Sepolia', lastSeenAt: '2026-09-22T00:00:00.000Z' }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Heartbeats and component detail/ }));
    expect(screen.getByText('No heartbeats for this chain.')).toBeTruthy();
    expect(screen.queryByText('No heartbeats recorded yet.')).toBeNull();
  });

  it('keeps the overview attention count when the wallets page filter changes', async () => {
    const fetchMock = installFetch();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Wallets needing attention/ }).textContent).toContain('1');
    });

    window.location.hash = '#/wallets';
    fireEvent(window, new HashChangeEvent('hashchange'));
    fireEvent.change(await screen.findByLabelText('Enabled'), { target: { value: 'true' } });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0] as RequestInfo | URL));
      expect(urls.some((url) => url.includes('enabled=true'))).toBe(true);
    });

    window.location.hash = '#/overview';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByRole('link', { name: /Wallets needing attention/ }).textContent).toContain('1');
  });

  it('filters rows to the selected chain, badges the other chain, and does not refetch', async () => {
    const fetchMock = installFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { level: 3, name: /Public · Ethereum Sepolia/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: /Public · Base Sepolia/ })).toBeTruthy();

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0] as RequestInfo | URL));
      expect(urls.some((url) => url.includes('/balance'))).toBe(true);
    });
    const callsBeforeSelect = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Base Sepolia/ }));

    expect(screen.queryByRole('heading', { level: 3, name: /Ethereum Sepolia/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: /Public · Base Sepolia/ })).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSelect);

    window.location.hash = '#/wallets';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 3, name: 'Fresco' })).toBeTruthy();
    const walletsPanel = sectionByHeading('Managed wallets');
    expect(within(walletsPanel).queryByText(/0xaaaa…aaaa/)).toBeNull();
    expect(within(walletsPanel).getByText(/0xbbbb…bbbb/)).toBeTruthy();

    window.location.hash = '#/funding';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByText(/2\.22/)).toBeTruthy();
    expect(screen.queryByText(/1\.11/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ethereum Sepolia/ }));
    expect(within(screen.getByRole('button', { name: /Base Sepolia/ })).getByText('1')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: /Base Sepolia/ })).getByText('unavailable'),
    ).toBeTruthy();
    expect(screen.getByText(/1\.11/)).toBeTruthy();
    expect(screen.queryByText(/2\.22/)).toBeNull();

    window.location.hash = '#/reconciliation';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Reconciliation' })).toBeTruthy();
    expect(screen.queryByText('unexplained_outgoing_transfer')).toBeNull();
    expect(screen.queryByTestId('chain-unavailable')).toBeNull();

    window.location.hash = '#/alerts';
    fireEvent(window, new HashChangeEvent('hashchange'));
    const findings = await screen.findAllByText('unexplained_outgoing_transfer');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((node) => node.closest('article')?.textContent?.includes('Base Sepolia'))).toBe(
      true,
    );
    expect(screen.queryByTestId('chain-unavailable')).toBeNull();

    window.location.hash = '#/email';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByText(/T10\.6/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    window.location.hash = '#/overview';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 3, name: /Public · Ethereum Sepolia/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: /Public · Base Sepolia/ })).toBeTruthy();
  });

  it('badges a dark chain from the loaded run even when that chain is not selected', () => {
    const loaded = segments();
    const attention = attentionByChain({
      segments: loaded,
      treasuries: twoTreasuries(),
      runs: [runWithFindings([unavailableBase()])],
      openFindingAlerts: [],
      acknowledgedFindingAlerts: [],
      findingAlertsState: 'ready',
      openFindingAlertsComplete: true,
    });
    render(
      <ChainFilterControl
        segments={loaded}
        selection={SEPOLIA}
        attention={attention}
        onSelect={() => undefined}
      />,
    );

    const base = screen.getByRole('button', { name: /Base Sepolia/ });
    expect(within(base).getByText('unavailable')).toBeTruthy();
    expect(within(base).queryByText('1')).toBeNull();
    expect(base.getAttribute('aria-pressed')).toBe('false');
  });
});

function FilterProbe(props: { readonly treasuries: readonly TreasuryResource[] }): ReactElement {
  const filter = useChainFilter(props.treasuries, true);
  return (
    <ChainFilterControl
      segments={filter.segments}
      selection={filter.selection}
      attention={[]}
      onSelect={filter.selectChain}
    />
  );
}

function segmentLabels(): string[] {
  return within(screen.getByRole('group', { name: 'Chain' }))
    .getAllByRole('button')
    .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function sectionByHeading(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const section = heading.closest('section');
  if (section === null) {
    throw new Error(`No section for ${name}`);
  }
  return section;
}

function segments(): readonly ChainSegment[] {
  return [
    { chainId: SEPOLIA, displayName: 'Ethereum Sepolia' },
    { chainId: BASE, displayName: 'Base Sepolia' },
  ];
}

function treasury(input: {
  readonly id: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly status: TreasuryResource['status'];
  readonly address?: string;
}): TreasuryResource {
  const address = input.address ?? '0x1111111111111111111111111111111111111111';
  return {
    id: input.id,
    kind: 'external',
    displayKind: 'Public',
    status: input.status,
    enabled: true,
    address,
    explorerUrl: `https://example.test/address/${address}`,
    chain: {
      slug: 'chain',
      chainId: input.chainId,
      displayName: input.displayName,
      nativeSymbol: 'ETH',
    },
    balance: { wei: '1000000000000000000', ether: '1', observedAt: '2026-09-22T00:00:00.000Z' },
    spendable: { wei: '1000000000000000000', ether: '1' },
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

function twoTreasuries(): readonly TreasuryResource[] {
  return [
    treasury({
      id: 'treasury-base',
      chainId: BASE,
      displayName: 'Base Sepolia',
      status: 'critical',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    treasury({
      id: 'treasury-sepolia',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      status: 'healthy',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
  ];
}

function wallet(input: {
  readonly id: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly address: string;
  readonly reconciliationEnabled: boolean;
  readonly minimumBalanceWei: string | null;
}): ManagedWalletResource {
  return {
    id: input.id,
    project: { id: 'project-1', slug: 'fresco', name: 'Fresco', enabled: true },
    environment: { id: 'env-1', slug: 'dev', name: 'Dev', enabled: true },
    chain: { slug: 'chain', chainId: input.chainId, displayName: input.displayName, nativeSymbol: 'ETH' },
    role: 'batcher',
    address: input.address,
    explorerUrl: `https://example.test/address/${input.address}`,
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: input.reconciliationEnabled,
    policy:
      input.minimumBalanceWei === null
        ? null
        : {
            minimumBalanceWei: input.minimumBalanceWei,
            targetBalanceWei: '5',
            maximumTopUpWei: '4',
            version: 1,
            updatedAt: '2026-09-22T00:00:00.000Z',
          },
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
}

function overviewWallets(): readonly ManagedWalletResource[] {
  return [
    wallet({
      id: 'wallet-sepolia-off',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reconciliationEnabled: false,
      minimumBalanceWei: null,
    }),
    wallet({
      id: 'wallet-sepolia-low',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
      reconciliationEnabled: true,
      minimumBalanceWei: '2',
    }),
    wallet({
      id: 'wallet-sepolia-ok',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac',
      reconciliationEnabled: true,
      minimumBalanceWei: '2',
    }),
    wallet({
      id: 'wallet-base-off',
      chainId: BASE,
      displayName: 'Base Sepolia',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reconciliationEnabled: false,
      minimumBalanceWei: '2',
    }),
  ];
}

function overviewProps(): OverviewPageProps {
  const treasuries = [
    treasury({
      id: 'treasury-sepolia',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      status: 'healthy',
    }),
    treasury({
      id: 'treasury-sepolia-warn',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      status: 'warning',
      address: '0x2222222222222222222222222222222222222222',
    }),
    treasury({
      id: 'treasury-base',
      chainId: BASE,
      displayName: 'Base Sepolia',
      status: 'critical',
      address: '0x3333333333333333333333333333333333333333',
    }),
  ];
  return {
    treasuries: {
      loadTreasuries: () => Promise.resolve(),
      loadTreasuryFundingHistory: () => Promise.resolve(),
      treasuriesState: 'ready',
      treasuriesError: undefined,
      treasuries,
      treasuryBusyId: undefined,
      onCheck: () => Promise.resolve(),
      treasuryFundingHistoryState: 'empty',
      treasuryFundingHistoryError: undefined,
      treasuryFundingHistory: [],
      visibleChainIds: ALL_CHAINS,
    },
    wallets: overviewWallets(),
    walletsState: 'ready',
    walletBalances: {
      'wallet-sepolia-low': {
        status: 'observed',
        wei: '1',
        ether: '0.000000000000000001',
        observedAt: '2026-09-22T00:00:00.000Z',
      },
      'wallet-sepolia-ok': {
        status: 'observed',
        wei: '5',
        ether: '0.000000000000000005',
        observedAt: '2026-09-22T00:00:00.000Z',
      },
    },
    openFindingAlerts: [openAlert('alert-base'), openAlert('alert-sepolia')],
    findingAlertsState: 'ready',
    reconciliationRuns: [runWithFindings([])],
    reconciliationState: 'ready',
    visibleChainIds: ALL_CHAINS,
  };
}

function openAlert(id: string): OverviewPageProps['openFindingAlerts'][number] {
  return {
    id,
    alertType: 'treasury_finding',
    severity: 'critical',
    entityType: 'treasury',
    entityId: TX_HASH,
    state: 'open',
    firstTriggeredAt: '2026-09-22T06:00:00.000Z',
    lastEvaluatedAt: '2026-09-22T06:00:00.000Z',
    lastSentAt: null,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    metadata: { treasuryId: 'treasury-base', findingKind: 'unexplained_outgoing_transfer' },
  };
}

function unavailableBase(): Record<string, unknown> {
  return {
    kind: 'chain_outcome',
    severity: 'warning',
    chainId: BASE,
    status: 'unavailable',
    reason: 'RPC did not answer',
  };
}

function runWithFindings(findings: readonly Record<string, unknown>[]): ReconciliationRunResource {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    runId: 'run-1',
    requestedBy: 'cron',
    startedAt: '2026-09-22T06:00:00.000Z',
    finishedAt: '2026-09-22T06:00:20.000Z',
    walletsAssessed: 2,
    walletsFunded: 0,
    walletsNoop: 2,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: '0',
    weiTransferredEther: '0',
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: findings.some((finding) => finding.kind === 'unexplained_outgoing_transfer')
      ? 1
      : 0,
    outgoingScanStatus: 'complete',
    findings,
    errorCode: null,
    errorSummary: null,
  };
}

function installFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    return Promise.resolve(liveResponse(url));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function liveResponse(url: string): Response {
  if (url.includes('/v1/auth/me')) {
    return jsonResponse(200, {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        role: 'operator',
      },
      permissions: ['treasury:read', 'wallet:read', 'project:read', 'reconciliation:read', 'alert:read'],
    });
  }
  if (url.includes('/health/ready')) {
    return jsonResponse(200, {
      status: 'ok',
      checkedAt: '2026-09-22T00:00:00.000Z',
      components: [
        { name: 'database', status: 'ok', detail: null },
        { name: 'rpc', status: 'failed', detail: 'The RPC endpoint reports chain 84532.' },
      ],
      heartbeats: [],
    });
  }
  if (url.includes('/v1/treasuries')) {
    return jsonResponse(200, { data: twoTreasuries() });
  }
  if (url.includes('/v1/alerts')) {
    const acknowledged = url.includes('state=acknowledged');
    return jsonResponse(200, {
      data: acknowledged ? [] : [openAlert('alert-base')],
      pagination: { limit: 50, offset: 0, total: acknowledged ? 0 : 1 },
    });
  }
  if (url.includes('/v1/reconciliation-runs')) {
    return jsonResponse(200, {
      data: [
        runWithFindings([
          {
            severity: 'critical',
            kind: 'unexplained_outgoing_transfer',
            treasuryId: 'treasury-base',
            transactionHash: TX_HASH,
            valueWei: '1000000000000000000',
          },
          unavailableBase(),
          {
            kind: 'chain_outcome',
            severity: 'warning',
            chainId: SEPOLIA,
            status: 'processed',
          },
        ]),
      ],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
  }
  if (url.includes('/v1/projects') && !url.includes('/environments')) {
    return jsonResponse(200, {
      data: [
        {
          id: 'project-1',
          slug: 'fresco',
          name: 'Fresco',
          enabled: true,
          createdAt: '2026-09-22T00:00:00.000Z',
          updatedAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
  }
  if (url.includes('/balance')) {
    return jsonResponse(200, {
      balance: {
        outcome: 'observed',
        wei: '5',
        ether: '0.000000000000000005',
        blockNumber: '1',
        observedAt: '2026-09-22T00:00:00.000Z',
      },
    });
  }
  if (url.includes('/v1/wallets')) {
    const attention = wallet({
      id: 'wallet-sepolia-off',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: '0xcccccccccccccccccccccccccccccccccccccccc',
      reconciliationEnabled: false,
      minimumBalanceWei: '1',
    });
    const listed = [
      wallet({
        id: 'wallet-sepolia',
        chainId: SEPOLIA,
        displayName: 'Ethereum Sepolia',
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reconciliationEnabled: true,
        minimumBalanceWei: '1',
      }),
      wallet({
        id: 'wallet-base',
        chainId: BASE,
        displayName: 'Base Sepolia',
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        reconciliationEnabled: true,
        minimumBalanceWei: '1',
      }),
    ];
    // A Wallets-page filter must not become the overview population.
    if (url.includes('enabled=') || url.includes('projectId=') || url.includes('environmentId=')) {
      return jsonResponse(200, {
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      });
    }
    return jsonResponse(200, {
      data: [...listed, attention],
      pagination: { limit: 50, offset: 0, total: 3 },
    });
  }
  if (url.includes('/v1/funding-transactions')) {
    return jsonResponse(200, {
      data: [
        transfer('tx-sepolia', SEPOLIA, 'Ethereum Sepolia', '1.11'),
        transfer('tx-base', BASE, 'Base Sepolia', '2.22'),
      ],
      pagination: { limit: 50, offset: 0, total: 2 },
    });
  }
  return jsonResponse(200, { data: [], pagination: { limit: 50, offset: 0, total: 0 } });
}

function transfer(
  id: string,
  chainId: number,
  displayName: string,
  amountEther: string,
): FundingTransactionResource {
  return {
    id,
    operation: {
      id: `op-${id}`,
      operationType: 'ensure_funded',
      status: 'confirmed',
      requestedBy: 'operator',
      startedAt: '2026-09-22T01:00:00.000Z',
      completedAt: '2026-09-22T01:00:20.000Z',
    },
    project: { id: 'project-1', slug: 'fresco', name: 'Fresco', enabled: true },
    environment: { id: 'env-1', slug: 'dev', name: 'Dev', enabled: true },
    wallet: { id: 'wallet', role: 'batcher', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    chain: { slug: 'chain', chainId, displayName, nativeSymbol: 'ETH' },
    amountWei: '1',
    amountEther,
    status: 'confirmed',
    transactionHash: TX_HASH,
    explorerUrl: null,
    nonce: 1,
    errorCode: null,
    createdAt: '2026-09-22T01:00:00.000Z',
    submittedAt: '2026-09-22T01:00:10.000Z',
    confirmedAt: '2026-09-22T01:00:20.000Z',
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
