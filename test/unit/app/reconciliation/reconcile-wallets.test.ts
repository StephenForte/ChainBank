import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { reconcileWallets } from '../../../../src/app/reconciliation/reconcile-wallets.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  EmailMessage,
  EmailSender,
  FundingTransaction,
  InsertOpenAlertInput,
  ManagedWallet,
  ManagedWalletRepository,
  RecordOutgoingScanCompleteInput,
  StoredOpenAlert,
  Treasury,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
import { classifyReconciliationRun } from '../../../../src/app/alerts/notify-reconciliation-failure.js';
import { classifyReconcilerExit, reconcilerExitCode } from '../../../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import {
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
  createInMemoryFundingStores,
  createInMemoryReconciliationFundingQuery,
  createInMemoryReconciliationRunRepository,
} from '../../../support/funding-fakes.js';

function collectLogs(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const ONE_ETH = 10n ** 18n;
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
const WALLET_A = '0x2222222222222222222222222222222222222222';
const WALLET_B = '0x3333333333333333333333333333333333333333';
const now = new Date('2026-08-01T18:00:00.000Z');

function buildTreasury(overrides: Partial<Treasury> = {}): Treasury {
  return {
    id: 'treasury-1',
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    address: TREASURY_ADDRESS.toLowerCase(),
    addressDisplay: TREASURY_ADDRESS,
    thresholds: {
      warningBalanceWei: ONE_ETH,
      criticalBalanceWei: ONE_ETH / 4n,
      recoveryBalanceWei: 2n * ONE_ETH,
      minimumReserveWei: ONE_ETH / 10n,
    },
    status: 'healthy',
    lastObservedBalanceWei: undefined,
    lastObservedAt: undefined,
    lastCheckedAt: undefined,
    lastCheckErrorCode: undefined,
    lastOutgoingScanBlock: undefined,
    lastOutgoingScanAt: undefined,
    lastOutgoingScanNonce: undefined,
    enabled: true,
    ...overrides,
  };
}

function buildWallet(id: string, address: string, overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id,
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
    address: address.toLowerCase(),
    addressDisplay: address,
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: true,
    policy: {
      id: `policy-${id}`,
      managedWalletId: id,
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

describe('reconcileWallets authorization', () => {
  it('denies API roles that lack reconciliation:run', async () => {
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [], buildTreasury());

    await expect(
      reconcileWallets(deps, {
        role: 'operator',
        credentialId: 'cred-op',
        correlationId: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    await expect(
      reconcileWallets(deps, {
        role: 'project-service',
        credentialId: 'cred-ps',
        correlationId: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('reconcileWallets sweep decisions', () => {
  it('funds only below-minimum eligible wallets and records summary math', async () => {
    const below = buildWallet('w-below', WALLET_A);
    const above = buildWallet('w-above', WALLET_B);
    const disabled = buildWallet('w-off', '0x4444444444444444444444444444444444444444', {
      reconciliationEnabled: false,
    });
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A]: ONE_ETH / 10n,
        [WALLET_B]: ONE_ETH,
        '0x4444444444444444444444444444444444444444': 0n,
      },
    });
    const deps = buildDeps(stores, [below, above, disabled], buildTreasury(), {
      signer,
      balanceReader,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-sweep',
      runId: 'run-1',
    });

    expect(signer.sendCalls).toBe(1);
    expect(result.counters.funded).toBe(1);
    expect(result.counters.noop).toBe(1);
    expect(result.counters.assessed).toBe(2);
    expect(result.run.finishedAt).toBeDefined();
    expect(result.run.walletsFunded).toBe(1);
    expect(result.run.walletsNoop).toBe(1);
  });

  it('stops submitting after reserve but continues assessing remaining wallets', async () => {
    const first = buildWallet('w-1', WALLET_A);
    const second = buildWallet('w-2', WALLET_B);
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    // Treasury barely above reserve so first top-up is blocked.
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: ONE_ETH / 10n + 1_000n,
        [WALLET_A]: 0n,
        [WALLET_B]: 0n,
      },
    });
    const deps = buildDeps(stores, [first, second], buildTreasury(), {
      signer,
      balanceReader,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-reserve',
      runId: 'run-reserve',
    });

    expect(signer.sendCalls).toBe(0);
    expect(result.counters.blocked).toBe(2);
    expect(result.counters.assessed).toBe(2);
  });

  it('flags unexplained on-chain transfers as critical findings', async () => {
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'ee'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH / 2n,
          nonce: 9,
          blockNumber: 50n,
        },
      ],
    });
    const deps = buildDeps(stores, [], buildTreasury(), { outgoingScanner: scanner });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-orphan',
      runId: 'run-orphan',
    });

    expect(result.unexplainedTransferCount).toBe(1);
    expect(result.findings.some((f) => f.kind === 'unexplained_outgoing_transfer')).toBe(true);
    expect(result.outgoingScanStatus).toBe('complete');
  });

  it('logs critical findings at error and still classifies the run as C15 success / exit 0', async () => {
    const sink = collectLogs();
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'b1'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH,
          nonce: 3,
          // Must sit inside the fake scanner tip window (default tip 1000).
          blockNumber: 50n,
        },
      ],
    });
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: 'msg-1' });
      },
    };
    const deps = {
      ...buildDeps(stores, [], buildTreasury(), {
        outgoingScanner: scanner,
        logger: createLogger({
          level: 'error',
          serviceRole: 'test',
          environment: 'test',
          destination: sink.stream,
        }),
      }),
      alerts: createWorkingAlertRepository(),
      emailSender,
    };

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-finding-log',
      runId: 'run-finding-log',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.run.errorCode).toBeUndefined();
    expect(classifyReconciliationRun(result.run)).toBe('success');
    expect(classifyReconcilerExit(result.run.errorCode)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain(orphanHash);

    const critical = sink.lines().find((line) => line.event === 'reconciliation.critical_finding');
    expect(critical).toBeDefined();
    expect(critical?.level).toBe('error');
    expect(critical?.transactionHash).toBe(orphanHash);
    expect(typeof critical?.valueWei).toBe('string');
    expect(() => JSON.stringify(critical)).not.toThrow();
  });

  it('marks outgoing scan incomplete on RPC failure rather than a clean report', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner();
    scanner.setListIncomplete('RPC_UNAVAILABLE', 'simulated outage');
    const deps = buildDeps(stores, [], buildTreasury(), { outgoingScanner: scanner });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-scan',
      runId: 'run-scan',
    });

    expect(result.outgoingScanStatus).toBe('incomplete');
    expect(result.findings.some((f) => f.kind === 'outgoing_scan_incomplete')).toBe(true);
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('keeps the run outcome when the reconciliation-failure alert hook throws', async () => {
    const stores = createInMemoryFundingStores();
    const deps = {
      ...buildDeps(stores, [], buildTreasury()),
      signer: undefined,
      reconcileFailureAlertThreshold: 1,
    };
    deps.alerts.findOpenByEntity = () => Promise.reject(new Error('alert store down'));

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-alert-iso',
      runId: 'run-alert-iso',
    });

    expect(result.run.errorCode).toBe('SIGNER_UNAVAILABLE');
    expect(result.run.finishedAt).toBeDefined();
    expect(result.outgoingScanStatus).toBe('not-run');
    expect(deps.alerts.insertOpen).not.toHaveBeenCalled();
  });

  it('keeps the run outcome when the treasury-finding alert hook throws', async () => {
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'cd'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH / 2n,
          nonce: 9,
          blockNumber: 50n,
        },
      ],
    });
    const deps = buildDeps(stores, [], buildTreasury(), { outgoingScanner: scanner });
    deps.alerts.findOpenByEntity = () => Promise.reject(new Error('finding alert store down'));

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-finding-iso',
      runId: 'run-finding-iso',
    });

    expect(result.run.errorCode).toBeUndefined();
    expect(result.run.finishedAt).toBeDefined();
    expect(result.unexplainedTransferCount).toBe(1);
    expect(classifyReconciliationRun(result.run)).toBe('success');
    expect(classifyReconcilerExit(result.run.errorCode)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
  });

  it('still logs and emails critical findings when watermark advance throws', async () => {
    const sink = collectLogs();
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'ab'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH,
          nonce: 3,
          blockNumber: 50n,
        },
      ],
    });
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: 'msg-1' });
      },
    };
    const deps = {
      ...buildDeps(stores, [], buildTreasury(), {
        outgoingScanner: scanner,
        logger: createLogger({
          level: 'error',
          serviceRole: 'test',
          environment: 'test',
          destination: sink.stream,
        }),
      }),
      alerts: createWorkingAlertRepository(),
      emailSender,
    };
    deps.treasuries.recordOutgoingScanComplete = vi.fn(() =>
      Promise.reject(new Error('watermark write failed')),
    );

    await expect(
      reconcileWallets(deps, {
        role: 'cron-reconciler',
        credentialId: 'cron-cred',
        correlationId: 'corr-watermark-fail',
        runId: 'run-watermark-fail',
      }),
    ).rejects.toThrow('watermark write failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain(orphanHash);
    const critical = sink.lines().find((line) => line.event === 'reconciliation.critical_finding');
    expect(critical).toBeDefined();
    expect(critical?.transactionHash).toBe(orphanHash);
  });

  it('alerts a later distinct finding when an earlier finding notify throws', async () => {
    const stores = createInMemoryFundingStores();
    const hashA = `0x${'a1'.repeat(32)}`;
    const hashB = `0x${'b2'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: hashA,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH,
          nonce: 3,
          blockNumber: 40n,
        },
        {
          transactionHash: hashB,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_B,
          valueWei: ONE_ETH / 2n,
          nonce: 4,
          blockNumber: 50n,
        },
      ],
    });
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };
    const alerts = createWorkingAlertRepository();
    const originalFind = alerts.findOpenByEntity.bind(alerts);
    alerts.findOpenByEntity = (entityType, entityId, alertType) => {
      if (entityId === hashA) {
        return Promise.reject(new Error('first finding alert store down'));
      }
      return originalFind(entityType, entityId, alertType);
    };

    const deps = {
      ...buildDeps(stores, [], buildTreasury(), { outgoingScanner: scanner }),
      alerts,
      emailSender,
    };

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-finding-partial',
      runId: 'run-finding-partial',
    });

    expect(result.unexplainedTransferCount).toBe(2);
    expect(result.run.errorCode).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain(hashB);
    expect(messages[0]?.text).not.toContain(hashA);
  });
});

describe('reconcileWallets outgoing scan bookkeeping (TX.9)', () => {
  it('resumes incrementally from a stored marker and advances it on success', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: 1_050n });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({ lastOutgoingScanBlock: 1_000n, lastOutgoingScanAt: now }),
      { outgoingScanner: scanner, outgoingLookbackBlocks: 20_000n },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-resume',
      runId: 'run-resume',
    });

    expect(scanner.listCalls).toEqual([
      { fromAddress: TREASURY_ADDRESS, fromBlock: 1_001n, toBlock: 1_050n },
    ]);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_050n,
      scannedNonce: 0,
      scannedAt: now,
    });
    expect(result.outgoingScanStatus).toBe('complete');
  });

  it('uses a tip-relative capped window when no marker exists', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: 50_000n });
    const deps = buildDeps(stores, [], buildTreasury(), {
      outgoingScanner: scanner,
      outgoingLookbackBlocks: 20_000n,
    });

    await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-first',
      runId: 'run-first',
    });

    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 30_000n, toBlock: 50_000n });
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 50_000n }),
    );
  });

  it('scans forward-contiguously when the gap exceeds the cap and reports incomplete while behind', async () => {
    // Rewritten (TX.9 round 2): tip-facing skip-ahead was fail-closed inverted —
    // marker advanced past an unscanned window. Forward-contiguous is required.
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: 50_000n });
    const deps = buildDeps(stores, [], buildTreasury({ lastOutgoingScanBlock: 1_000n }), {
      outgoingScanner: scanner,
      outgoingLookbackBlocks: 20_000n,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-behind',
      runId: 'run-behind',
    });

    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 1_001n, toBlock: 21_000n });
    expect(result.outgoingScanStatus).toBe('incomplete');
    const behind = result.findings.find((f) => f.kind === 'outgoing_scan_coverage_behind');
    expect(behind).toMatchObject({
      kind: 'outgoing_scan_coverage_behind',
      lastScannedBlock: '1000',
      scannedFromBlock: '1001',
      scannedToBlock: '21000',
      tip: '50000',
      blocksRemaining: '29000',
    });
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 21_000n }),
    );
  });

  it('reports an unexplained transfer inside the capped forward window (never abandons it)', async () => {
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'aa'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 50_000n,
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH / 2n,
          nonce: 9,
          blockNumber: 5_000n,
        },
      ],
    });
    const deps = buildDeps(stores, [], buildTreasury({ lastOutgoingScanBlock: 1_000n }), {
      outgoingScanner: scanner,
      outgoingLookbackBlocks: 20_000n,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-orphan-window',
      runId: 'run-orphan-window',
    });

    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 1_001n, toBlock: 21_000n });
    expect(result.unexplainedTransferCount).toBe(1);
    expect(
      result.findings.some(
        (f) => f.kind === 'unexplained_outgoing_transfer' && f.transactionHash === orphanHash,
      ),
    ).toBe(true);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 21_000n }),
    );
    // Marker must not jump past the unscanned tip-side backlog.
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 50_000n }),
    );
  });

  it('does not advance the watermark when markFinished fails', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: 1_050n, confirmedNonce: 7 });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanNonce: 7,
      }),
      { outgoingScanner: scanner },
    );
    deps.reconciliationRuns.markFinished = () => Promise.reject(new Error('forced markFinished failure'));

    await expect(
      reconcileWallets(deps, {
        role: 'cron-reconciler',
        credentialId: 'cron-cred',
        correlationId: 'corr-mark-fail',
        runId: 'run-mark-fail',
      }),
    ).rejects.toThrow('forced markFinished failure');

    // TX.14: skip path queues watermark+nonce, but neither flushes without markFinished.
    expect(scanner.listCalls).toHaveLength(0);
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('records not-run when there are zero enabled treasuries', async () => {
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [], buildTreasury());
    deps.treasuries.listEnabled = () => Promise.resolve([]);

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-zero-treasury',
      runId: 'run-zero-treasury',
    });

    expect(result.outgoingScanStatus).toBe('not-run');
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('does not advance the marker when the scan fails', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: 2_000n });
    scanner.setListIncomplete('RPC_UNAVAILABLE', 'partial failure');
    const deps = buildDeps(stores, [], buildTreasury({ lastOutgoingScanBlock: 1_000n }), {
      outgoingScanner: scanner,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-no-advance',
      runId: 'run-no-advance',
    });

    expect(result.outgoingScanStatus).toBe('incomplete');
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('records outgoingScanStatus not-run on every early-exit path', async () => {
    const stores = createInMemoryFundingStores();

    const disabled = buildDeps(stores, [], buildTreasury(), {
      isFundingEnabled: false,
    });

    const disabledResult = await reconcileWallets(disabled, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-disabled',
      runId: 'run-disabled',
    });
    expect(disabledResult.outgoingScanStatus).toBe('not-run');
    expect(disabledResult.run.outgoingScanStatus).toBe('not-run');
    expect(disabledResult.run.errorCode).toBe('FUNDING_DISABLED');

    const killSwitch = buildDeps(stores, [], buildTreasury(), {
      isFundingKillSwitchActive: true,
    });
    const killResult = await reconcileWallets(killSwitch, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-kill',
      runId: 'run-kill',
    });
    expect(killResult.outgoingScanStatus).toBe('not-run');

    const noSigner = { ...buildDeps(stores, [], buildTreasury()), signer: undefined };
    const noSignerResult = await reconcileWallets(noSigner, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-nosigner',
      runId: 'run-nosigner',
    });
    expect(noSignerResult.outgoingScanStatus).toBe('not-run');
  });

  it('logs policy refusals below error under a distinct event', async () => {
    const sink = collectLogs();
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [], buildTreasury(), {
      isFundingEnabled: false,
      logger: createLogger({
        level: 'info',
        serviceRole: 'test',
        environment: 'test',
        destination: sink.stream,
      }),
    });

    await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-policy-log',
      runId: 'run-policy-log',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const lines = sink.lines();
    expect(lines.some((line) => line.event === 'reconciliation.run.failed')).toBe(false);
    const policy = lines.find((line) => line.event === 'reconciliation.run.policy_disabled');
    expect(policy).toBeDefined();
    expect(policy?.level).toBe('warn');
  });

  it('leaves submission_unknown pending when the nonce is outside the searched window', async () => {
    const stores = createInMemoryFundingStores();
    const unknown: FundingTransaction = {
      id: 'tx-unknown',
      operationId: 'op-unknown',
      treasuryId: 'treasury-1',
      managedWalletId: 'w-missing',
      transactionHash: undefined,
      nonce: 5,
      amountWei: ONE_ETH / 2n,
      status: 'submission_unknown',
      errorCode: undefined,
      submittedAt: undefined,
      confirmedAt: undefined,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    stores.txsById.set(unknown.id, unknown);

    const scanner = createFakeOutgoingScanner({
      confirmedNonce: 6,
      findByNonce: () => ({ kind: 'not_found' }),
      latestBlockNumber: 1_000n,
    });
    const deps = buildDeps(stores, [], buildTreasury(), {
      outgoingScanner: scanner,
      outgoingLookbackBlocks: 100n,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-nonce-window',
      runId: 'run-nonce-window',
    });

    expect(result.submissionUnknownLeftPending).toBe(1);
    expect(result.submissionUnknownResolved).toBe(0);
    expect(stores.txsById.get(unknown.id)?.status).toBe('submission_unknown');
    expect(scanner.findByNonceCalls[0]?.lookbackBlocks).toBe(100n);
  });
});

describe('reconcileWallets nonce-gated outgoing scan (TX.14)', () => {
  it('skips the body scan when tip nonce equals the stored watermark nonce', async () => {
    const sink = collectLogs();
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      confirmedNonce: 12,
    });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanAt: now,
        lastOutgoingScanNonce: 12,
      }),
      {
        outgoingScanner: scanner,
        logger: createLogger({
          level: 'info',
          serviceRole: 'test',
          environment: 'test',
          destination: sink.stream,
        }),
      },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-nonce-skip',
      runId: 'run-nonce-skip',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(scanner.listCalls).toHaveLength(0);
    expect(scanner.countAtBlockCalls).toEqual([{ address: TREASURY_ADDRESS, blockNumber: 1_050n }]);
    // Headline: steady-state skip ≤ tip + count (2 scanner RPC calls).
    expect(scanner.scannerRpcCallCount()).toBeLessThanOrEqual(2);
    expect(scanner.scannerRpcCallCount()).toBe(2);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_050n,
      scannedNonce: 12,
      scannedAt: now,
    });
    expect(result.outgoingScanStatus).toBe('complete');
    expect(result.unexplainedTransferCount).toBe(0);

    const skipLog = sink
      .lines()
      .find((line) => line.event === 'reconciliation.outgoing_scan.skipped_nonce_gate');
    expect(skipLog).toMatchObject({
      storedNonce: 12,
      tipNonce: 12,
      treasuryId: 'treasury-1',
    });
  });

  it('runs a full scan on nonce delta and still reports unexplained transfers', async () => {
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'bb'.repeat(32)}`;
    const windowBlocks = 50n;
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      confirmedNonce: 13,
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH / 2n,
          nonce: 12,
          blockNumber: 1_025n,
        },
      ],
    });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanNonce: 12,
      }),
      { outgoingScanner: scanner },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-nonce-delta',
      runId: 'run-nonce-delta',
    });

    expect(scanner.listCalls).toEqual([
      { fromAddress: TREASURY_ADDRESS, fromBlock: 1_001n, toBlock: 1_050n },
    ]);
    // Non-skip path pays the body-list cost; production lists ~window block fetches.
    expect(scanner.listCalls[0]!.toBlock - scanner.listCalls[0]!.fromBlock + 1n).toBe(windowBlocks);
    expect(result.unexplainedTransferCount).toBe(1);
    expect(
      result.findings.some(
        (f) => f.kind === 'unexplained_outgoing_transfer' && f.transactionHash === orphanHash,
      ),
    ).toBe(true);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_050n,
      scannedNonce: 13,
      scannedAt: now,
    });
    expect(result.outgoingScanStatus).toBe('complete');
  });

  it('fails closed to a full scan when the tip-nonce read is unavailable', async () => {
    const sink = collectLogs();
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      confirmedNonce: 12,
    });
    scanner.setCountAtBlockUnavailable('RPC_UNAVAILABLE', 'count probe down');
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanNonce: 12,
      }),
      {
        outgoingScanner: scanner,
        logger: createLogger({
          level: 'info',
          serviceRole: 'test',
          environment: 'test',
          destination: sink.stream,
        }),
      },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-nonce-unavailable',
      runId: 'run-nonce-unavailable',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(scanner.listCalls).toHaveLength(1);
    expect(result.outgoingScanStatus).toBe('complete');
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 1_050n, scannedNonce: 12 }),
    );
    expect(
      sink.lines().some((line) => line.event === 'reconciliation.outgoing_scan.skipped_nonce_gate'),
    ).toBe(false);
  });

  it('full-scans when stored nonce is null, records nonce, then skips on the next run', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      confirmedNonce: 4,
    });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanAt: now,
        lastOutgoingScanNonce: undefined,
      }),
      { outgoingScanner: scanner },
    );

    const first = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-seed-nonce',
      runId: 'run-seed-nonce',
    });

    expect(scanner.listCalls).toHaveLength(1);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_050n,
      scannedNonce: 4,
      scannedAt: now,
    });
    expect(first.outgoingScanStatus).toBe('complete');

    scanner.setLatestBlockNumber(1_100n);
    scanner.listCalls.length = 0;
    scanner.countAtBlockCalls.length = 0;
    scanner.latestBlockCalls.length = 0;

    const second = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-after-seed',
      runId: 'run-after-seed',
    });

    expect(scanner.listCalls).toHaveLength(0);
    expect(scanner.scannerRpcCallCount()).toBeLessThanOrEqual(2);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenLastCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_100n,
      scannedNonce: 4,
      scannedAt: now,
    });
    expect(second.outgoingScanStatus).toBe('complete');
  });
});

function createWorkingAlertRepository(): AlertRepository {
  const rows = new Map<string, StoredOpenAlert>();
  let seq = 0;
  return {
    findOpenByEntity(entityType, entityId, alertType) {
      return Promise.resolve(
        [...rows.values()].find(
          (row) => row.entityType === entityType && row.entityId === entityId && row.alertType === alertType,
        ),
      );
    },
    insertOpen(input: InsertOpenAlertInput) {
      const id = `alert-${String(++seq)}`;
      const row: StoredOpenAlert = {
        id,
        alertType: input.alertType,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
        firstTriggeredAt: input.firstTriggeredAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        lastSentAt: undefined,
        pendingEmail: input.pendingEmail,
        metadata: { ...input.metadata, pendingEmail: input.pendingEmail },
      };
      rows.set(id, row);
      return Promise.resolve(row);
    },
    markEscalated() {
      return Promise.reject(new Error('unused'));
    },
    markPendingEmail(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        return Promise.reject(new Error('missing alert'));
      }
      const next: StoredOpenAlert = {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: input.pendingEmail,
        metadata: {
          ...existing.metadata,
          ...(input.metadata ?? {}),
          pendingEmail: input.pendingEmail,
        },
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    clearPendingEmail() {
      return Promise.reject(new Error('unused'));
    },
    acknowledgeSend(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        return Promise.reject(new Error('missing alert'));
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: StoredOpenAlert = {
        ...existing,
        lastSentAt: input.lastSentAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    resolve() {
      return Promise.reject(new Error('unused'));
    },
    touchLastEvaluated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        return Promise.resolve();
      }
      rows.set(input.id, {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        metadata:
          input.metadata === undefined ? existing.metadata : { ...existing.metadata, ...input.metadata },
      });
      return Promise.resolve();
    },
  };
}

function buildDeps(
  stores: ReturnType<typeof createInMemoryFundingStores>,
  wallets: readonly ManagedWallet[],
  treasury: Treasury,
  overrides: {
    readonly signer?: ReturnType<typeof createFakeSigner>;
    readonly balanceReader?: ReturnType<typeof createFakeBalanceReader>;
    readonly outgoingScanner?: ReturnType<typeof createFakeOutgoingScanner>;
    readonly outgoingLookbackBlocks?: bigint;
    readonly isFundingEnabled?: boolean;
    readonly isFundingKillSwitchActive?: boolean;
    readonly logger?: ReturnType<typeof createLogger>;
  } = {},
) {
  const managedWallets: ManagedWalletRepository = {
    insert: vi.fn(),
    findById(id) {
      return Promise.resolve(wallets.find((wallet) => wallet.id === id));
    },
    list() {
      return Promise.resolve({ items: wallets.filter((w) => w.enabled), total: wallets.length });
    },
    update: vi.fn(),
  };

  let currentTreasury = treasury;
  const treasuries: TreasuryRepository = {
    upsert: vi.fn(),
    findById: vi.fn(),
    listEnabled: () => Promise.resolve([currentTreasury]),
    setEnabled: vi.fn(),
    recordCheckSuccess: vi.fn(),
    recordCheckFailure: vi.fn(),
    recordOutgoingScanComplete: vi.fn((input: RecordOutgoingScanCompleteInput) => {
      currentTreasury = {
        ...currentTreasury,
        lastOutgoingScanBlock: input.scannedToBlock,
        lastOutgoingScanAt: input.scannedAt,
        lastOutgoingScanNonce: input.scannedNonce,
      };
      return Promise.resolve(currentTreasury);
    }),
  };

  const balanceObservations: BalanceObservationRepository = {
    record: () => Promise.resolve(),
    findLatest: () => Promise.resolve(undefined),
  };

  const auditEvents: AuditEventRepository = {
    record: () => Promise.resolve(),
  };

  const alerts: AlertRepository = {
    findOpenByEntity: () => Promise.resolve(undefined),
    insertOpen: vi.fn(),
    markEscalated: vi.fn(),
    markPendingEmail: vi.fn(),
    clearPendingEmail: vi.fn(),
    acknowledgeSend: vi.fn(),
    resolve: vi.fn(),
    touchLastEvaluated: vi.fn(),
  };

  return {
    managedWallets,
    treasuries,
    balanceObservations,
    balanceReader:
      overrides.balanceReader ??
      createFakeBalanceReader({
        balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH },
      }),
    auditEvents,
    alerts,
    emailSender: undefined,
    operations: stores.operations,
    transactions: stores.transactions,
    reconciliationRuns: createInMemoryReconciliationRunRepository(),
    reconciliationFunding: createInMemoryReconciliationFundingQuery(stores.txsById),
    outgoingScanner: overrides.outgoingScanner ?? createFakeOutgoingScanner(),
    lock: stores.lock,
    receiptTracker: createFakeReceiptTracker({
      kind: 'confirmed',
      confirmedAt: now,
    }),
    signer: overrides.signer ?? createFakeSigner({ address: TREASURY_ADDRESS }),
    clock: createFixedClock(now),
    idGenerator: (() => {
      let n = 0;
      return { next: () => `id-${String(++n)}` };
    })(),
    logger: overrides.logger ?? createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
    isFundingEnabled: overrides.isFundingEnabled ?? true,
    isFundingKillSwitchActive: overrides.isFundingKillSwitchActive ?? false,
    confirmations: 1,
    confirmationTimeoutMs: 1_000,
    operatorRecipients: ['ops@example.com'],
    dashboardBaseUrl: 'http://localhost:3000',
    environment: 'test',
    reconcileFailureAlertThreshold: 3,
    ...(overrides.outgoingLookbackBlocks === undefined
      ? {}
      : { outgoingLookbackBlocks: overrides.outgoingLookbackBlocks }),
  };
}
