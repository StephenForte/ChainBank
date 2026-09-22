import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import type { ReconciliationRunResource, TreasuryResource } from '../src/api';
import { ReconciliationPanel } from '../src/pages/panels/reconciliation-panel';

afterEach(() => {
  cleanup();
});

const BASE_CHAIN_ID = 84_532;
const SEPOLIA_CHAIN_ID = 11_155_111;

function treasury(chainId: number, displayName: string): TreasuryResource {
  return {
    id: `treasury-${String(chainId)}`,
    status: 'healthy',
    enabled: true,
    address: '0x1111111111111111111111111111111111111111',
    explorerUrl: 'https://sepolia.basescan.org/address/0x1111111111111111111111111111111111111111',
    chain: { slug: 'chain', chainId, displayName, nativeSymbol: 'ETH' },
    balance: { wei: null, ether: null, observedAt: null },
    spendable: { wei: null, ether: null },
    thresholds: {
      warningEther: '1',
      criticalEther: '0.3',
      recoveryEther: '1.5',
      minimumReserveEther: '0.1',
    },
    lastCheckedAt: null,
    lastCheckErrorCode: null,
  };
}

function makeRun(findings: readonly Record<string, unknown>[]): ReconciliationRunResource {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: 'run-dark',
    requestedBy: 'cron',
    startedAt: '2026-09-22T06:00:00.000Z',
    finishedAt: '2026-09-22T06:00:20.000Z',
    walletsAssessed: 2,
    walletsFunded: 1,
    walletsNoop: 1,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: '0',
    weiTransferredEther: '0',
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: 0,
    outgoingScanStatus: 'complete',
    findings,
    errorCode: null,
    errorSummary: null,
  };
}

function renderPanel(options: {
  readonly findings: readonly Record<string, unknown>[];
  readonly expanded: boolean;
  readonly treasuries?: readonly TreasuryResource[];
}): void {
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
      treasuries={
        options.treasuries ?? [
          treasury(SEPOLIA_CHAIN_ID, 'Ethereum Sepolia'),
          treasury(BASE_CHAIN_ID, 'Base Sepolia'),
        ]
      }
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
      reconciliationRuns={[makeRun(options.findings)]}
      openFindingAlertsComplete
      expandedCriticalEntityIds={{}}
      setExpandedCriticalEntityIds={boolSetter}
      ackDraftByEntityId={{}}
      setAckDraftByEntityId={setter}
      ackErrorByEntityId={{}}
      ackBusyEntityId={undefined}
      onAcknowledgeFindingByEntity={() => Promise.resolve()}
      reconciliationDetailExpanded={options.expanded}
      onToggleReconciliationDetail={() => undefined}
    />,
  );
}

describe('reconciliation panel chain outcomes (C30)', () => {
  it('shows a dark Base chain without expanding the detail section', () => {
    renderPanel({
      expanded: false,
      findings: [
        {
          kind: 'chain_outcome',
          severity: 'warning',
          chainId: SEPOLIA_CHAIN_ID,
          status: 'processed',
        },
        {
          kind: 'chain_outcome',
          severity: 'warning',
          chainId: BASE_CHAIN_ID,
          status: 'unavailable',
          reason: 'RPC did not answer',
        },
      ],
    });

    const callout = screen.getByTestId('chain-unavailable');
    expect(callout.textContent).toContain('Base Sepolia was unavailable');
    expect(callout.textContent).toContain('RPC did not answer');
    expect(callout.closest('#reconciliation-detail')).toBeNull();
    expect(document.getElementById('reconciliation-detail')).toBeNull();
    expect(
      screen.getByText('Base Sepolia was unavailable', { selector: '.recon-chain-unavailable' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Ethereum Sepolia/)).toBeNull();
    expect(screen.queryByText('chain_outcome')).toBeNull();
  });

  it('renders a single-chain processed run with no chain-outcome noise', () => {
    renderPanel({
      expanded: true,
      treasuries: [treasury(SEPOLIA_CHAIN_ID, 'Ethereum Sepolia')],
      findings: [
        {
          kind: 'chain_outcome',
          severity: 'warning',
          chainId: SEPOLIA_CHAIN_ID,
          status: 'processed',
        },
      ],
    });

    expect(screen.queryByTestId('chain-unavailable')).toBeNull();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(screen.queryByText('chain_outcome')).toBeNull();
    expect(screen.queryByText('Ethereum Sepolia')).toBeNull();
    expect(screen.getByText('No warning findings in the loaded runs.')).toBeTruthy();
  });

  it('renders an unknown kind and a chain outcome missing chainId without throwing (C22)', () => {
    renderPanel({
      expanded: true,
      findings: [
        { severity: 'panic', kind: 'made_up_kind' },
        { severity: 'warning', kind: 'chain_outcome' },
      ],
    });

    expect(screen.getByText('made_up_kind')).toBeTruthy();
    expect(screen.getByText('unclassified')).toBeTruthy();
    expect(screen.getByText('chain_outcome')).toBeTruthy();
    expect(screen.getByText(/Unknown chain · unknown status/)).toBeTruthy();
  });

  it('keeps an unacknowledged critical visible while detail is collapsed (C20)', () => {
    renderPanel({
      expanded: false,
      findings: [
        {
          severity: 'critical',
          kind: 'unexplained_outgoing_transfer',
          treasuryId: 'treasury-1',
          transactionHash: '0xbc4adabf121e000000000000000000000000000000000000000000000000121e',
          valueWei: '1000000000000000000',
        },
      ],
    });

    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('unexplained_outgoing_transfer')).toBeTruthy();
    expect(screen.queryByText('Warning findings')).toBeNull();
    expect(document.getElementById('reconciliation-detail')).toBeNull();
  });
});
