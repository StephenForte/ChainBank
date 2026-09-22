import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import { App } from '../src/App';
import { CollapsibleSection } from '../src/collapsible-section';
import type { TreasuryResource } from '../src/api';
import { ReconciliationPanel } from '../src/pages/panels/reconciliation-panel';
import { TreasuriesPanel } from '../src/pages/panels/treasuries-panel';

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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
});

const NAV_LABELS = [
  'Overview',
  'Treasuries',
  'Wallets',
  'Funding',
  'Reconciliation',
  'Alerts',
  'Email',
  'Admin',
] as const;

describe('dashboard shell (C32)', () => {
  it('renders the wallets page for #/wallets, overview for an unknown hash, and updates on hashchange', () => {
    window.location.hash = '#/not-a-page';
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Service readiness' })).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(
      Array.from(nav.querySelectorAll('a')).map((anchor) => anchor.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([...NAV_LABELS]);
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');

    window.location.hash = '#/wallets';
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Wallets' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Managed wallets' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Service readiness' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Wallets' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('keeps an unacknowledged critical finding visible without a toggle click (C20)', () => {
    renderCriticalFinding();

    const kind = screen.getByText('unexplained_outgoing_transfer');
    expect(kind).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
    expect(kind.closest('.collapse-body')).toBeNull();
    expect(kind.closest('article')?.querySelector('.collapse-toggle')).toBeNull();
    expect(document.getElementById('reconciliation-detail')).toBeNull();
  });

  it('remembers an expanded block across a remount', () => {
    const storageKey = 'chainbank.collapse.policy.test-wallet';

    function Probe() {
      return (
        <CollapsibleSection title="Policy detail" storageKey={storageKey}>
          <p>minimum 1 ETH</p>
        </CollapsibleSection>
      );
    }

    const first = render(<Probe />);
    expect(screen.queryByText('minimum 1 ETH')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Policy detail/ }));
    expect(screen.getByText('minimum 1 ETH')).toBeTruthy();
    expect(window.localStorage.getItem(storageKey)).toBe('true');

    first.unmount();
    render(<Probe />);
    expect(screen.getByText('minimum 1 ETH')).toBeTruthy();
  });

  it('shows the compact treasury card until thresholds are expanded', () => {
    render(
      <TreasuriesPanel
        loadTreasuries={() => Promise.resolve()}
        loadTreasuryFundingHistory={() => Promise.resolve()}
        token="operator-token"
        treasuriesState="ready"
        treasuriesError={undefined}
        treasuries={[treasuryFixture()]}
        treasuryBusyId={undefined}
        onCheck={() => Promise.resolve()}
        treasuryFundingHistoryState="empty"
        treasuryFundingHistoryError={undefined}
        treasuryFundingHistory={[]}
      />,
    );

    expect(screen.getByRole('heading', { level: 3, name: /Public · Ethereum Sepolia/ })).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByRole('link', { name: treasuryFixture().address })).toBeTruthy();
    expect(screen.getByText('1.25 ETH')).toBeTruthy();
    expect(screen.getByText('0.8 ETH')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    expect(screen.queryByText(/warn 0\.75/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Thresholds and last checked/ }));
    expect(screen.getByText(/warn 0\.75/)).toBeTruthy();
  });
});

function treasuryFixture(): TreasuryResource {
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

function renderCriticalFinding(): void {
  const setter = vi.fn() as unknown as Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
  const boolSetter = vi.fn() as unknown as Dispatch<SetStateAction<Readonly<Record<string, boolean>>>>;
  render(
    <ReconciliationPanel
      loadReconciliationRuns={() => Promise.resolve()}
      loadFindingAlerts={() => Promise.resolve()}
      token="operator-token"
      findingAlertsState="ready"
      findingAlertsError={undefined}
      openFindingAlerts={[]}
      treasuries={[]}
      ackDraftByAlertId={{}}
      ackErrorByAlertId={{}}
      ackBusyId={undefined}
      setAckDraftByAlertId={setter}
      onAcknowledgeFinding={() => Promise.resolve()}
      acknowledgedFindingAlerts={[]}
      acknowledgedFindingsExpanded={false}
      onToggleAcknowledgedFindings={() => undefined}
      reconciliationState="ready"
      reconciliationError={undefined}
      reconciliationRunsTotal={1}
      reconciliationRuns={[
        {
          id: '11111111-1111-4111-8111-111111111111',
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
              treasuryId: 'treasury-1',
              transactionHash: '0xbc4adabf121e000000000000000000000000000000000000000000000000121e',
              valueWei: '1000000000000000000',
            },
          ],
          errorCode: null,
          errorSummary: null,
        },
      ]}
      openFindingAlertsComplete
      expandedCriticalEntityIds={{}}
      setExpandedCriticalEntityIds={boolSetter}
      ackDraftByEntityId={{}}
      setAckDraftByEntityId={setter}
      ackErrorByEntityId={{}}
      ackBusyEntityId={undefined}
      onAcknowledgeFindingByEntity={() => Promise.resolve()}
      reconciliationDetailExpanded={false}
      onToggleReconciliationDetail={() => undefined}
    />,
  );
}
