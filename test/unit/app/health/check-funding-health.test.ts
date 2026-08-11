import { describe, expect, it, vi } from 'vitest';
import {
  checkFundingHealth,
  classifyOverallStatus,
  FUNDING_HEALTH_STALE_AFTER_MS,
  isFinishedRunFresh,
} from '../../../../src/app/health/check-funding-health.js';
import type {
  FundingHealthQuery,
  ManagedWallet,
  ManagedWalletRepository,
  ReconciliationRun,
  ReconciliationRunRepository,
  WalletFundingAttemptRecord,
  WalletLastFundedRecord,
} from '../../../../src/app/ports.js';
import { createFakeBalanceReader } from '../../../support/funding-fakes.js';
import { createFixedClock } from '../../../support/clock.js';

const NOW = new Date('2026-08-11T19:00:00.000Z');
const ONE_ETH = 10n ** 18n;
/** Above Number.MAX_SAFE_INTEGER — must survive JSON as an unchanged string. */
const HUGE_WEI = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2

const BATCHER = '0x3D54FD6353cd66D143fb94D178c9eEB1aE98a31d';

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id: 'wallet-batcher',
    project: { id: 'proj-1', slug: 'fortel2', name: 'ForteL2', enabled: true },
    environment: {
      id: 'env-1',
      projectId: 'proj-1',
      slug: 'sepolia',
      name: 'Sepolia',
      enabled: true,
    },
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    role: 'fortel2-batcher',
    address: BATCHER.toLowerCase(),
    addressDisplay: BATCHER,
    enabled: true,
    criticalAtStartup: true,
    reconciliationEnabled: true,
    policy: {
      id: 'policy-1',
      managedWalletId: 'wallet-batcher',
      minimumBalanceWei: 600_000_000_000_000_000n,
      targetBalanceWei: ONE_ETH,
      maximumTopUpWei: ONE_ETH,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function finishedRun(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  return {
    id: 'run-row-1',
    runId: 'run-fresh',
    requestedBy: 'wallet-reconciler',
    startedAt: new Date('2026-08-11T18:00:00.000Z'),
    finishedAt: new Date('2026-08-11T18:00:31.000Z'),
    walletsAssessed: 4,
    walletsFunded: 1,
    walletsNoop: 3,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: 600_000_000_000_000_000n,
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: 0,
    outgoingScanStatus: 'complete',
    findings: [],
    errorCode: undefined,
    errorSummary: undefined,
    ...overrides,
  };
}

function buildDeps(options: {
  readonly run?: ReconciliationRun | undefined;
  readonly wallets?: readonly ManagedWallet[];
  readonly balances?: Record<string, bigint>;
  readonly funded?: readonly WalletLastFundedRecord[];
  readonly attempts?: readonly WalletFundingAttemptRecord[];
}) {
  const run = options.run;
  const wallets = options.wallets ?? [buildWallet()];
  const reconciliationRuns: ReconciliationRunRepository = {
    insertStarted: vi.fn(),
    markFinished: vi.fn(),
    findById: vi.fn(),
    listRecent: vi.fn(),
    findLatestFinished: () => Promise.resolve(run),
    list: vi.fn(),
    count: vi.fn(),
  };
  const managedWallets: ManagedWalletRepository = {
    insert: vi.fn(),
    findById: vi.fn(),
    list: () => Promise.resolve({ items: [...wallets], total: wallets.length }),
    update: vi.fn(),
  };
  const fundingHealth: FundingHealthQuery = {
    findLatestFundedByWalletIds: () => Promise.resolve(options.funded ?? []),
    findLatestReconcileAttemptsSince: () => Promise.resolve(options.attempts ?? []),
  };
  const balances: Record<string, bigint> = {
    [BATCHER]: 672_741_447_840_395_160n,
    ...(options.balances ?? {}),
  };
  return {
    reconciliationRuns,
    managedWallets,
    fundingHealth,
    balanceReader: createFakeBalanceReader({ balances }),
    clock: createFixedClock(NOW),
  };
}

describe('isFinishedRunFresh — aborted rows never satisfy freshness', () => {
  it('rejects finished_at IS NULL even when outgoingScanStatus looks complete', () => {
    const aborted = finishedRun({
      finishedAt: undefined,
      startedAt: new Date('2026-08-11T18:30:00.000Z'),
      outgoingScanStatus: 'complete',
    });
    expect(isFinishedRunFresh(aborted, NOW)).toBe(false);
  });

  it('accepts a finished run inside the 12h window', () => {
    expect(isFinishedRunFresh(finishedRun(), NOW)).toBe(true);
  });

  it('rejects a finished run older than two schedule cycles', () => {
    const stale = finishedRun({
      finishedAt: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS - 1),
    });
    expect(isFinishedRunFresh(stale, NOW)).toBe(false);
  });
});

describe('checkFundingHealth endpoint states', () => {
  it('returns ok for a fresh successful run with wallets at policy', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun(),
        funded: [
          {
            managedWalletId: 'wallet-batcher',
            fundedAt: new Date('2026-08-08T18:00:39.000Z'),
            amountWei: 600_000_000_000_000_000n,
            transactionHash: `0x${'ab'.repeat(32)}`,
          },
        ],
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.lastRun?.exitKind).toBe('success');
    // 19:00:00 − 18:00:31 = 3569s — age uses finishedAt, not startedAt.
    expect(result.lastRun?.ageSeconds).toBe(3569);
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]?.status).toBe('ok');
    expect(result.wallets[0]?.address).toBe(BATCHER);
    // ForteL2 matches wallets by address — empty would be as disruptive as a 500.
    expect(result.wallets[0]?.address.length).toBeGreaterThan(0);
  });

  it('includes every policy wallet with a non-empty address, including reconciliation-excluded ones', async () => {
    const excludedAddress = '0x1111111111111111111111111111111111111111';
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun(),
        wallets: [
          buildWallet(),
          buildWallet({
            id: 'wallet-paused',
            role: 'fortel2-paused',
            address: excludedAddress.toLowerCase(),
            addressDisplay: excludedAddress,
            reconciliationEnabled: false,
            policy: {
              id: 'policy-paused',
              managedWalletId: 'wallet-paused',
              minimumBalanceWei: 600_000_000_000_000_000n,
              targetBalanceWei: ONE_ETH,
              maximumTopUpWei: ONE_ETH,
              version: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          }),
          buildWallet({
            id: 'wallet-no-policy',
            role: 'unmanaged',
            address: '0x2222222222222222222222222222222222222222',
            addressDisplay: '0x2222222222222222222222222222222222222222',
            policy: undefined,
          }),
        ],
        balances: {
          [BATCHER]: 672_741_447_840_395_160n,
          [excludedAddress]: 100n,
        },
      }),
    );

    expect(result.wallets).toHaveLength(2);
    for (const wallet of result.wallets) {
      expect(typeof wallet.address).toBe('string');
      expect(wallet.address.length).toBeGreaterThan(0);
    }
    const paused = result.wallets.find((wallet) => wallet.address === excludedAddress);
    expect(paused?.status).toBe('not_reconciled');
    // Below-policy balance on a non-reconciled wallet must not drag overall status.
    expect(result.status).toBe('ok');
  });

  it('marks disabled-entity policy wallets as not_reconciled rather than omitting them', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun(),
        wallets: [buildWallet({ enabled: false })],
        balances: { [BATCHER]: 100n },
      }),
    );

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]?.status).toBe('not_reconciled');
    expect(result.wallets[0]?.address).toBe(BATCHER);
    expect(result.status).toBe('ok');
  });

  it('returns failing when the last successfully finished run is older than 12h', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun({
          finishedAt: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS - 60_000),
        }),
      }),
    );
    expect(result.status).toBe('failing');
  });

  it('returns failing when only an aborted run exists (finished_at IS NULL trap)', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: undefined, // findLatestFinished skips aborted rows
      }),
    );
    expect(result.status).toBe('failing');
    expect(result.lastRun).toBeUndefined();
  });

  it('returns degraded when a wallet is below policy with a per-wallet attempt inside the window', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun(),
        balances: { [BATCHER]: 100n },
        attempts: [
          {
            managedWalletId: 'wallet-batcher',
            attemptedAt: new Date('2026-08-11T18:00:30.000Z'),
            outcome: 'pending',
            errorCode: undefined,
            amountWei: undefined,
            transactionHash: undefined,
          },
        ],
      }),
    );
    expect(result.status).toBe('degraded');
    expect(result.wallets[0]?.status).toBe('below_policy');
  });

  it('returns failing when a below-policy wallet has no attempt even if a fresh sweep assessed others', async () => {
    // Finding 1: aggregate walletsAssessed must not credit an unassessed wallet.
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun({ walletsAssessed: 4, walletsFunded: 1, walletsNoop: 3 }),
        balances: { [BATCHER]: 100n },
        attempts: [],
      }),
    );
    expect(result.status).toBe('failing');
    expect(result.wallets[0]?.status).toBe('below_policy');
  });

  it('reports per-wallet blocked (not below_policy) when the reconcile attempt was reserve-blocked', async () => {
    // Finding 2: durable FUNDING_BLOCKED_RESERVE attempt drives wallet status.
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun({ walletsBlocked: 1, walletsFunded: 0, walletsNoop: 0 }),
        balances: { [BATCHER]: 100n },
        attempts: [
          {
            managedWalletId: 'wallet-batcher',
            attemptedAt: new Date('2026-08-11T18:00:30.000Z'),
            outcome: 'blocked',
            errorCode: 'FUNDING_BLOCKED_RESERVE',
            amountWei: undefined,
            transactionHash: undefined,
          },
        ],
      }),
    );
    expect(result.status).toBe('degraded');
    expect(result.wallets[0]?.status).toBe('blocked');
  });

  it('returns degraded when the latest finished run reported walletsBlocked > 0', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun({ walletsBlocked: 2, walletsFunded: 0, walletsNoop: 2 }),
      }),
    );
    expect(result.status).toBe('degraded');
  });

  it('preserves wei above Number.MAX_SAFE_INTEGER as an unchanged decimal string', async () => {
    const result = await checkFundingHealth(
      buildDeps({
        run: finishedRun(),
        balances: { [BATCHER]: HUGE_WEI },
        funded: [
          {
            managedWalletId: 'wallet-batcher',
            fundedAt: new Date('2026-08-08T18:00:39.000Z'),
            amountWei: HUGE_WEI,
            transactionHash: `0x${'cd'.repeat(32)}`,
          },
        ],
      }),
    );

    const wallet = result.wallets[0];
    expect(wallet?.balanceWei).toBe(HUGE_WEI.toString());
    expect(wallet?.lastFundedWei).toBe(HUGE_WEI.toString());
    expect(typeof wallet?.balanceWei).toBe('string');
    // Number() silently loses precision above MAX_SAFE_INTEGER — BigInt must round-trip.
    expect(Number.isSafeInteger(Number(wallet?.balanceWei))).toBe(false);
    expect(BigInt(wallet?.balanceWei ?? '0')).toBe(HUGE_WEI);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(`"balanceWei":"${HUGE_WEI.toString()}"`);
    expect(serialized).toContain(`"lastFundedWei":"${HUGE_WEI.toString()}"`);
    const roundTrip = JSON.parse(serialized) as {
      wallets: Array<{ balanceWei: string; lastFundedWei: string }>;
    };
    expect(roundTrip.wallets[0]?.balanceWei).toBe(HUGE_WEI.toString());
    expect(roundTrip.wallets[0]?.lastFundedWei).toBe(HUGE_WEI.toString());
    expect(BigInt(roundTrip.wallets[0]?.balanceWei ?? '0')).toBe(HUGE_WEI);
  });
});

describe('classifyOverallStatus', () => {
  it('ignores not_reconciled wallets when computing overall status', () => {
    const status = classifyOverallStatus({
      checkedAt: NOW,
      lastFinished: finishedRun(),
      lastRun: {
        runId: 'run-fresh',
        finishedAt: '2026-08-11T18:00:31.000Z',
        exitKind: 'success',
        ageSeconds: 3569,
        walletsBlocked: 0,
        walletsFailed: 0,
      },
      drafts: [
        {
          walletId: 'wallet-paused',
          view: {
            label: 'paused',
            address: BATCHER,
            chainId: 11_155_111,
            balanceWei: '0',
            policyMinWei: '600000000000000000',
            lastFundedAt: undefined,
            lastFundedWei: undefined,
            lastFundedTxHash: undefined,
            status: 'not_reconciled',
          },
        },
      ],
      attemptByWallet: new Map(),
      windowStart: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS),
    });
    expect(status).toBe('ok');
  });

  it('treats below-policy with no attempt inside the window as failing', () => {
    const status = classifyOverallStatus({
      checkedAt: NOW,
      lastFinished: finishedRun({
        finishedAt: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS - 1),
        walletsAssessed: 0,
        errorCode: 'FUNDING_DISABLED',
      }),
      lastRun: undefined,
      drafts: [
        {
          walletId: 'wallet-batcher',
          view: {
            label: 'fortel2-batcher',
            address: BATCHER,
            chainId: 11_155_111,
            balanceWei: '0',
            policyMinWei: '600000000000000000',
            lastFundedAt: undefined,
            lastFundedWei: undefined,
            lastFundedTxHash: undefined,
            status: 'below_policy',
          },
        },
      ],
      attemptByWallet: new Map(),
      windowStart: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS),
    });
    expect(status).toBe('failing');
  });

  it('treats below-policy with no per-wallet attempt as failing even when a fresh run assessed others', () => {
    const status = classifyOverallStatus({
      checkedAt: NOW,
      lastFinished: finishedRun({ walletsAssessed: 4 }),
      lastRun: {
        runId: 'run-fresh',
        finishedAt: '2026-08-11T18:00:31.000Z',
        exitKind: 'success',
        ageSeconds: 3569,
        walletsBlocked: 0,
        walletsFailed: 0,
      },
      drafts: [
        {
          walletId: 'wallet-new',
          view: {
            label: 'new-wallet',
            address: BATCHER,
            chainId: 11_155_111,
            balanceWei: '0',
            policyMinWei: '600000000000000000',
            lastFundedAt: undefined,
            lastFundedWei: undefined,
            lastFundedTxHash: undefined,
            status: 'below_policy',
          },
        },
      ],
      attemptByWallet: new Map(),
      windowStart: new Date(NOW.getTime() - FUNDING_HEALTH_STALE_AFTER_MS),
    });
    expect(status).toBe('failing');
  });
});
