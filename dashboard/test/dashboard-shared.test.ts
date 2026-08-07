import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertResource, ReconciliationRunResource, TreasuryResource } from '../src/api';
import {
  ACK_FINDINGS_STORAGE_KEY,
  areFindingAlertsResolved,
  asOptionalNumber,
  asOptionalString,
  BALANCE_AUTO_LOAD_MAX,
  balancePolicyChip,
  criticalFindingsSummaryLabel,
  explorerTxUrl,
  findingAlertEntityId,
  findingAlertMatchKey,
  findingEntityLabel,
  findingSeverity,
  formatClockTime,
  formatCompactRunTime,
  formatFindingWei,
  formatTimestamp,
  formatWeiAsEther,
  isCriticalFindingAcknowledged,
  loadAcknowledgedFindingsExpanded,
  loadReconciliationDetailExpanded,
  loadStoredToken,
  parseEtherInputToWei,
  RECON_DETAIL_STORAGE_KEY,
  storeAcknowledgedFindingsExpanded,
  storeReconciliationDetailExpanded,
  storeToken,
  toFindingViews,
  TOKEN_STORAGE_KEY,
  type FindingView,
} from '../src/dashboard-shared';

const TX_HASH = '0xBc4adabf121e000000000000000000000000000000000000000000000000121e';
const TX_HASH_LOWER = TX_HASH.toLowerCase();

function makeFinding(
  overrides: Partial<FindingView> & { readonly raw?: Record<string, unknown> },
): FindingView {
  return {
    severity: 'critical',
    kind: 'unexplained_outgoing_transfer',
    runId: 'run-1',
    runStartedAt: '2026-08-06T18:00:36.000Z',
    treasuryId: 'treasury-1',
    transactionHash: TX_HASH,
    toAddress: '0x512800000000000000000000000000000000652d',
    valueWei: '1000000000000000000',
    nonce: 3,
    blockNumber: '11425869',
    reason: undefined,
    raw: {},
    ...overrides,
  };
}

function makeAlert(entityId: string, state: 'open' | 'acknowledged'): AlertResource {
  return {
    id: `alert-${entityId}-${state}`,
    alertType: 'treasury_finding',
    severity: 'critical',
    entityType: 'treasury_finding',
    entityId,
    state,
    firstTriggeredAt: '2026-08-06T18:00:20.000Z',
    lastEvaluatedAt: '2026-08-06T18:00:20.000Z',
    lastSentAt: null,
    resolvedAt: null,
    acknowledgedAt: state === 'acknowledged' ? '2026-08-06T19:00:00.000Z' : null,
    acknowledgedBy: state === 'acknowledged' ? 'operator' : null,
    acknowledgementNote: state === 'acknowledged' ? 'stood down' : null,
    metadata: {},
  };
}

function makeRun(findings: readonly Record<string, unknown>[]): ReconciliationRunResource {
  return {
    id: 'id-1',
    runId: 'run-1',
    requestedBy: 'cron',
    startedAt: '2026-08-06T18:00:36.000Z',
    finishedAt: '2026-08-06T18:00:40.000Z',
    walletsAssessed: 4,
    walletsFunded: 0,
    walletsNoop: 4,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: '0',
    weiTransferredEther: '0',
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: findings.length,
    outgoingScanStatus: 'complete',
    findings,
    errorCode: null,
    errorSummary: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('findingAlertEntityId', () => {
  it('preserves errorCode case on the condition key (C18 / PR #88 asymmetry)', () => {
    const finding = makeFinding({
      kind: 'outgoing_scan_incomplete',
      transactionHash: undefined,
      raw: { errorCode: 'RPC_UNAVAILABLE' },
    });
    expect(findingAlertEntityId(finding)).toBe('outgoing_scan_incomplete:treasury-1:RPC_UNAVAILABLE');
  });

  it('lowercases the transaction-hash branch because C18 lowercases at the source', () => {
    expect(findingAlertEntityId(makeFinding({}))).toBe(TX_HASH_LOWER);
  });

  it('returns undefined when the finding cannot be keyed', () => {
    expect(
      findingAlertEntityId(
        makeFinding({
          kind: 'outgoing_scan_incomplete',
          treasuryId: undefined,
          transactionHash: undefined,
          raw: { errorCode: 'RPC_UNAVAILABLE' },
        }),
      ),
    ).toBeUndefined();
    expect(
      findingAlertEntityId(
        makeFinding({
          kind: 'outgoing_scan_incomplete',
          transactionHash: undefined,
          raw: {},
        }),
      ),
    ).toBeUndefined();
    expect(
      findingAlertEntityId(
        makeFinding({
          kind: 'something_else',
          transactionHash: undefined,
        }),
      ),
    ).toBeUndefined();
  });
});

describe('findingAlertMatchKey', () => {
  it('lowercases for comparison only, and differs from entityId on mixed-case condition keys', () => {
    const finding = makeFinding({
      kind: 'outgoing_scan_incomplete',
      transactionHash: undefined,
      raw: { errorCode: 'RPC_UNAVAILABLE' },
    });
    const entityId = findingAlertEntityId(finding);
    const matchKey = findingAlertMatchKey(finding);
    expect(entityId).toBe('outgoing_scan_incomplete:treasury-1:RPC_UNAVAILABLE');
    expect(matchKey).toBe('outgoing_scan_incomplete:treasury-1:rpc_unavailable');
    expect(matchKey).not.toBe(entityId);
  });
});

describe('isCriticalFindingAcknowledged', () => {
  const finding = makeFinding({});
  const ack = [makeAlert(TX_HASH_LOWER, 'acknowledged')];

  it('fails closed on loading / error / idle', () => {
    for (const state of ['loading', 'error', 'idle'] as const) {
      expect(isCriticalFindingAcknowledged(finding, state, [], ack, true)).toBe(false);
    }
  });

  it('fails closed when openAlertsComplete is false (truncated page cannot prove absence)', () => {
    expect(isCriticalFindingAcknowledged(finding, 'ready', [], ack, false)).toBe(false);
  });

  it('prefers open over acknowledged for a shared entityId', () => {
    const open = [makeAlert(TX_HASH_LOWER, 'open')];
    expect(isCriticalFindingAcknowledged(finding, 'ready', open, ack, true)).toBe(false);
  });

  it('returns false when no matching row exists', () => {
    expect(isCriticalFindingAcknowledged(finding, 'ready', [], [], true)).toBe(false);
  });

  it('returns true only with positive acknowledgement evidence', () => {
    expect(isCriticalFindingAcknowledged(finding, 'ready', [], ack, true)).toBe(true);
    expect(isCriticalFindingAcknowledged(finding, 'empty', [], ack, true)).toBe(true);
  });
});

describe('areFindingAlertsResolved', () => {
  it('is true only for ready and empty', () => {
    expect(areFindingAlertsResolved('ready')).toBe(true);
    expect(areFindingAlertsResolved('empty')).toBe(true);
    expect(areFindingAlertsResolved('loading')).toBe(false);
    expect(areFindingAlertsResolved('error')).toBe(false);
    expect(areFindingAlertsResolved('idle')).toBe(false);
  });
});

describe('explorerTxUrl', () => {
  const treasuries: readonly TreasuryResource[] = [
    {
      id: 'treasury-1',
      status: 'healthy',
      enabled: true,
      address: '0xTreasury',
      explorerUrl: 'https://sepolia.etherscan.io/address/0xTreasury',
      chain: {
        slug: 'sepolia',
        chainId: 11155111,
        displayName: 'Sepolia',
        nativeSymbol: 'ETH',
      },
      balance: { wei: null, ether: null, observedAt: null },
      spendable: { wei: null, ether: null },
      thresholds: {
        warningEther: '1',
        criticalEther: '0.5',
        recoveryEther: '2',
        minimumReserveEther: '0.1',
      },
      lastCheckedAt: null,
      lastCheckErrorCode: null,
    },
  ];

  it('does not produce a /tx/ link for a condition-kind finding key (#80)', () => {
    expect(
      explorerTxUrl(treasuries, 'treasury-1', 'outgoing_scan_incomplete:treasury-1:RPC_UNAVAILABLE'),
    ).toBeUndefined();
  });

  it('builds a /tx/ URL for a valid transaction hash', () => {
    expect(explorerTxUrl(treasuries, 'treasury-1', TX_HASH)).toBe(
      `https://sepolia.etherscan.io/tx/${TX_HASH}`,
    );
  });

  it('returns undefined for an unknown treasury or malformed explorerUrl', () => {
    expect(explorerTxUrl(treasuries, 'missing', TX_HASH)).toBeUndefined();
    expect(
      explorerTxUrl(
        [
          {
            ...treasuries[0]!,
            explorerUrl: 'https://sepolia.etherscan.io/tx/0xdead',
          },
        ],
        'treasury-1',
        TX_HASH,
      ),
    ).toBeUndefined();
  });
});

describe('findingEntityLabel', () => {
  it('labels only a 64-hex hash as Transaction', () => {
    expect(findingEntityLabel(TX_HASH)).toBe('Transaction');
    expect(findingEntityLabel(TX_HASH_LOWER)).toBe('Transaction');
    expect(findingEntityLabel('outgoing_scan_incomplete:treasury-1:RPC_UNAVAILABLE')).toBe('Finding key');
    expect(findingEntityLabel('0xabc')).toBe('Finding key');
  });
});

describe('formatFindingWei', () => {
  it('does not throw on "1.5" and renders labelled text (#84)', () => {
    expect(() => formatFindingWei('1.5')).not.toThrow();
    expect(formatFindingWei('1.5')).toBe('1.5 (unparseable wei)');
  });

  it('labels hostile and empty shapes without inventing a number', () => {
    expect(formatFindingWei(null)).toBe('null (unparseable wei)');
    expect(formatFindingWei(undefined)).toBe('undefined (unparseable wei)');
    expect(formatFindingWei({})).toBe('[object Object] (unparseable wei)');
    expect(formatFindingWei('abc')).toBe('abc (unparseable wei)');
    expect(formatFindingWei('')).toBe(' (unparseable wei)');
  });

  it('renders a valid decimal wei string as ETH', () => {
    expect(formatFindingWei('1500000000000000000')).toBe('1.5 ETH');
  });
});

describe('formatWeiAsEther / parseEtherInputToWei', () => {
  it('round-trips 18-decimal amounts without float loss', () => {
    const parsed = parseEtherInputToWei('1.000000000000000001');
    expect(parsed).toEqual({ ok: true, wei: '1000000000000000001' });
    if (parsed.ok) {
      expect(formatWeiAsEther(parsed.wei)).toBe('1.000000000000000001');
    }
  });

  it('accepts a leading dot and rejects empty, negative, and 19 decimals', () => {
    expect(parseEtherInputToWei('.5')).toEqual({ ok: true, wei: '500000000000000000' });
    expect(parseEtherInputToWei('')).toEqual({ ok: false, message: 'Amount is required.' });
    expect(parseEtherInputToWei('-1')).toEqual({
      ok: false,
      message: 'Enter a non-negative decimal ETH amount.',
    });
    expect(parseEtherInputToWei('1.0000000000000000001')).toEqual({
      ok: false,
      message: 'At most 18 decimal places.',
    });
  });
});

describe('balancePolicyChip', () => {
  it('warns strictly below minimum; exactly at minimum does not (C14 / C2)', () => {
    expect(balancePolicyChip('99', '100')).toEqual({
      className: 'badge badge-warn',
      label: 'below min',
    });
    expect(balancePolicyChip('100', '100')).toEqual({
      className: 'badge badge-ok',
      label: '≥ min',
    });
    expect(balancePolicyChip('101', '100')).toEqual({
      className: 'badge badge-ok',
      label: '≥ min',
    });
  });

  it('reports no policy when the minimum is absent', () => {
    expect(balancePolicyChip('100', undefined)).toEqual({
      className: 'badge badge-unknown',
      label: 'no policy',
    });
  });
});

describe('criticalFindingsSummaryLabel', () => {
  it('must not claim acknowledgement while alerts are unresolved', () => {
    expect(criticalFindingsSummaryLabel(0, 1, false)).toBe('1 critical finding');
    expect(criticalFindingsSummaryLabel(1, 1, false)).toBe('2 critical findings');
    expect(criticalFindingsSummaryLabel(0, 1, false)).not.toContain('acknowledged');
  });

  it('uses singular and plural correctly on each resolved branch', () => {
    expect(criticalFindingsSummaryLabel(0, 0, true)).toBe('0 critical findings');
    expect(criticalFindingsSummaryLabel(1, 0, true)).toBe('1 unacknowledged critical finding');
    expect(criticalFindingsSummaryLabel(2, 0, true)).toBe('2 unacknowledged critical findings');
    expect(criticalFindingsSummaryLabel(0, 1, true)).toBe('1 acknowledged critical finding');
    expect(criticalFindingsSummaryLabel(0, 2, true)).toBe('2 acknowledged critical findings');
    expect(criticalFindingsSummaryLabel(1, 1, true)).toBe(
      '1 unacknowledged · 1 acknowledged critical findings',
    );
  });
});

describe('toFindingViews / field narrowing', () => {
  it('treats whitespace-only strings and non-finite numbers as undefined', () => {
    expect(asOptionalString('   ')).toBeUndefined();
    expect(asOptionalString('')).toBeUndefined();
    expect(asOptionalString('ok')).toBe('ok');
    expect(asOptionalNumber(Number.NaN)).toBeUndefined();
    expect(asOptionalNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asOptionalNumber(3)).toBe(3);
  });

  it('maps unrecognised severity to unknown and still surfaces the finding', () => {
    expect(findingSeverity('panic')).toBe('unknown');
    const views = toFindingViews([
      makeRun([
        {
          severity: 'panic',
          kind: '   ',
          valueWei: '',
          nonce: Number.NaN,
        },
      ]),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      severity: 'unknown',
      kind: 'unknown',
      valueWei: undefined,
      nonce: undefined,
    });
  });
});

describe('BALANCE_AUTO_LOAD_MAX', () => {
  it('auto-loads at 25 listed wallets and not at 26 (C17 / TX.18)', () => {
    expect(BALANCE_AUTO_LOAD_MAX).toBe(25);
    // Mirrors App.tsx: auto-fetch when listed count > 0 && count <= BALANCE_AUTO_LOAD_MAX.
    const wouldAutoLoad = (listedCount: number): boolean =>
      listedCount > 0 && listedCount <= BALANCE_AUTO_LOAD_MAX;
    expect(wouldAutoLoad(25)).toBe(true);
    expect(wouldAutoLoad(26)).toBe(false);
  });
});

describe('storage helpers', () => {
  it('round-trips token and expand flags through session/local storage', () => {
    storeToken('  secret-token  ');
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('secret-token');
    expect(loadStoredToken()).toBe('secret-token');
    storeToken('');
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(loadStoredToken()).toBe('');

    storeReconciliationDetailExpanded(true);
    expect(localStorage.getItem(RECON_DETAIL_STORAGE_KEY)).toBe('true');
    expect(loadReconciliationDetailExpanded()).toBe(true);
    storeReconciliationDetailExpanded(false);
    expect(loadReconciliationDetailExpanded()).toBe(false);

    storeAcknowledgedFindingsExpanded(true);
    expect(localStorage.getItem(ACK_FINDINGS_STORAGE_KEY)).toBe('true');
    expect(loadAcknowledgedFindingsExpanded()).toBe(true);
  });

  it('falls back when the storage getter throws', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
      removeItem: () => {
        throw new Error('storage blocked');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    } satisfies Storage;

    vi.stubGlobal('sessionStorage', throwingStorage);
    vi.stubGlobal('localStorage', throwingStorage);

    expect(loadStoredToken()).toBe('');
    expect(() => storeToken('x')).not.toThrow();
    expect(loadReconciliationDetailExpanded()).toBe(false);
    expect(() => storeReconciliationDetailExpanded(true)).not.toThrow();
    expect(loadAcknowledgedFindingsExpanded()).toBe(false);
    expect(() => storeAcknowledgedFindingsExpanded(true)).not.toThrow();
  });
});

describe('toLocale formatters under TZ=UTC', () => {
  const iso = '2026-08-06T18:00:36.000Z';

  it('formatTimestamp returns the exact UTC locale string', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(iso)).toBe('8/6/2026, 6:00:36 PM');
  });

  it('formatClockTime returns HH:MM:SS in UTC', () => {
    expect(formatClockTime(iso)).toBe('18:00:36');
  });

  it('formatCompactRunTime returns the exact compact UTC string', () => {
    expect(formatCompactRunTime(iso)).toBe('8/6, 6:00 PM');
  });
});
