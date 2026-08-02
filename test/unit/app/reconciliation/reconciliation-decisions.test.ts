import { describe, expect, it } from 'vitest';
import {
  addSweepOutcome,
  assessWalletForSweep,
  classifyOutgoingAgainstRecords,
  emptySweepCounters,
  isEligibleForReconciliation,
  isMatchingSubmissionTransfer,
  NONCE_SEARCH_BLOCK_MARGIN,
  nonceSearchLookbackBlocks,
  planOutgoingScanWindow,
  RECONCILE_BLOCK_TIME_MS,
  reconciliationIdempotencyKey,
} from '../../../../src/app/reconciliation/reconciliation-decisions.js';
import type { ManagedWallet, TreasuryOutgoingTransfer } from '../../../../src/app/ports.js';

const ONE_ETH = 10n ** 18n;
const now = new Date('2026-08-01T12:00:00.000Z');

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id: 'wallet-1',
    project: { id: 'proj-1', slug: 'p', name: 'P', enabled: true },
    environment: {
      id: 'env-1',
      projectId: 'proj-1',
      slug: 'dev',
      name: 'Dev',
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
    role: 'signer',
    address: '0x2222222222222222222222222222222222222222',
    addressDisplay: '0x2222222222222222222222222222222222222222',
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: true,
    policy: {
      id: 'policy-1',
      managedWalletId: 'wallet-1',
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildTransfer(overrides: Partial<TreasuryOutgoingTransfer> = {}): TreasuryOutgoingTransfer {
  return {
    transactionHash: `0x${'aa'.repeat(32)}`,
    fromAddress: '0x1111111111111111111111111111111111111111',
    toAddress: '0x2222222222222222222222222222222222222222',
    valueWei: ONE_ETH,
    nonce: 3,
    blockNumber: 100n,
    ...overrides,
  };
}

describe('reconciliation decisions', () => {
  describe('isEligibleForReconciliation', () => {
    it('requires enabled wallet, reconciliation flag, project, and environment', () => {
      expect(isEligibleForReconciliation(buildWallet())).toBe(true);
      expect(isEligibleForReconciliation(buildWallet({ enabled: false }))).toBe(false);
      expect(isEligibleForReconciliation(buildWallet({ reconciliationEnabled: false }))).toBe(false);
      expect(
        isEligibleForReconciliation(
          buildWallet({ project: { id: 'proj-1', slug: 'p', name: 'P', enabled: false } }),
        ),
      ).toBe(false);
      expect(
        isEligibleForReconciliation(
          buildWallet({
            environment: {
              id: 'env-1',
              projectId: 'proj-1',
              slug: 'dev',
              name: 'Dev',
              enabled: false,
            },
          }),
        ),
      ).toBe(false);
    });
  });

  describe('assessWalletForSweep', () => {
    it('is a no-op at or above minimum even when below target (P4-US1)', () => {
      const wallet = buildWallet();
      expect(
        assessWalletForSweep({
          wallet,
          balanceWei: ONE_ETH,
          reserveStopped: false,
        }),
      ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
      expect(
        assessWalletForSweep({
          wallet,
          balanceWei: ONE_ETH + 1n,
          reserveStopped: false,
        }),
      ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
    });

    it('needs funding only when below minimum', () => {
      expect(
        assessWalletForSweep({
          wallet: buildWallet(),
          balanceWei: ONE_ETH - 1n,
          reserveStopped: false,
        }),
      ).toEqual({ kind: 'needs-funding' });
    });

    it('blocks without submitting after a reserve stop', () => {
      expect(
        assessWalletForSweep({
          wallet: buildWallet(),
          balanceWei: ONE_ETH / 10n,
          reserveStopped: true,
        }),
      ).toEqual({ kind: 'blocked', reason: 'reserve-stop' });
    });

    it('still no-ops at-or-above minimum after a reserve stop', () => {
      expect(
        assessWalletForSweep({
          wallet: buildWallet(),
          balanceWei: ONE_ETH,
          reserveStopped: true,
        }),
      ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
    });
  });

  describe('classifyOutgoingAgainstRecords', () => {
    it('marks unexplained transfers as critical candidates', () => {
      const transfer = buildTransfer({ transactionHash: `0x${'bb'.repeat(32)}` });
      expect(classifyOutgoingAgainstRecords(transfer, new Set([`0x${'aa'.repeat(32)}`]))).toEqual({
        kind: 'unexplained',
      });
      expect(
        classifyOutgoingAgainstRecords(transfer, new Set([transfer.transactionHash.toLowerCase()])),
      ).toEqual({ kind: 'explained' });
    });
  });

  describe('isMatchingSubmissionTransfer', () => {
    it('requires destination and amount match', () => {
      const transfer = buildTransfer({ valueWei: ONE_ETH });
      expect(
        isMatchingSubmissionTransfer({
          transfer,
          walletAddress: '0x2222222222222222222222222222222222222222',
          amountWei: ONE_ETH,
        }),
      ).toBe(true);
      expect(
        isMatchingSubmissionTransfer({
          transfer,
          walletAddress: '0x3333333333333333333333333333333333333333',
          amountWei: ONE_ETH,
        }),
      ).toBe(false);
      expect(
        isMatchingSubmissionTransfer({
          transfer,
          walletAddress: '0x2222222222222222222222222222222222222222',
          amountWei: ONE_ETH + 1n,
        }),
      ).toBe(false);
    });
  });

  describe('summary math', () => {
    it('aggregates assessed / funded / noop / blocked / failed and wei', () => {
      let counters = emptySweepCounters();
      counters = addSweepOutcome(counters, 'funded', ONE_ETH);
      counters = addSweepOutcome(counters, 'noop');
      counters = addSweepOutcome(counters, 'blocked');
      counters = addSweepOutcome(counters, 'failed');
      counters = addSweepOutcome(counters, 'funded', ONE_ETH / 2n);
      expect(counters).toEqual({
        assessed: 5,
        funded: 2,
        noop: 1,
        blocked: 1,
        failed: 1,
        weiTransferred: ONE_ETH + ONE_ETH / 2n,
      });
    });
  });

  it('builds deterministic reconcile idempotency keys', () => {
    expect(reconciliationIdempotencyKey('run-1', 'wallet-9')).toBe('reconcile:run-1:wallet-9');
  });

  describe('planOutgoingScanWindow', () => {
    it('falls back to a tip-relative capped window on first run', () => {
      const plan = planOutgoingScanWindow({
        tip: 50_000n,
        lastScannedBlock: undefined,
        maxBlocksPerRun: 20_000n,
      });
      expect(plan).toEqual({
        kind: 'scan',
        fromBlock: 30_000n,
        toBlock: 50_000n,
        tip: 50_000n,
        lastScannedBlock: undefined,
        isCoverageBehind: false,
        advanceMarkerTo: 50_000n,
      });
    });

    it('resumes contiguously from the stored marker when the gap fits the cap', () => {
      const plan = planOutgoingScanWindow({
        tip: 1_050n,
        lastScannedBlock: 1_000n,
        maxBlocksPerRun: 20_000n,
      });
      expect(plan).toEqual({
        kind: 'scan',
        fromBlock: 1_001n,
        toBlock: 1_050n,
        tip: 1_050n,
        lastScannedBlock: 1_000n,
        isCoverageBehind: false,
        advanceMarkerTo: 1_050n,
      });
    });

    it('scans the most recent cap-worth when the gap exceeds the cap', () => {
      const plan = planOutgoingScanWindow({
        tip: 50_000n,
        lastScannedBlock: 1_000n,
        maxBlocksPerRun: 20_000n,
      });
      expect(plan).toMatchObject({
        kind: 'scan',
        fromBlock: 30_000n,
        toBlock: 50_000n,
        isCoverageBehind: true,
        advanceMarkerTo: 50_000n,
      });
    });

    it('returns empty when the marker is already at the tip', () => {
      expect(
        planOutgoingScanWindow({
          tip: 9_000n,
          lastScannedBlock: 9_000n,
          maxBlocksPerRun: 20_000n,
        }),
      ).toEqual({ kind: 'empty', tip: 9_000n, lastScannedBlock: 9_000n });
    });
  });

  describe('nonceSearchLookbackBlocks', () => {
    it('bounds the hunt by row age and never exceeds the per-run cap', () => {
      const now = new Date('2026-08-02T00:00:00.000Z');
      const createdAt = new Date(now.getTime() - 100 * RECONCILE_BLOCK_TIME_MS);
      expect(nonceSearchLookbackBlocks({ createdAt, now, maxBlocks: 20_000n })).toBe(
        100n + NONCE_SEARCH_BLOCK_MARGIN,
      );

      const ancient = new Date(now.getTime() - 1_000_000 * RECONCILE_BLOCK_TIME_MS);
      expect(nonceSearchLookbackBlocks({ createdAt: ancient, now, maxBlocks: 20_000n })).toBe(20_000n);
    });
  });
});
