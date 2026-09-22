import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { custom, type Transport } from 'viem';
import { reconcileWallets } from '../../../../src/app/reconciliation/reconcile-wallets.js';
import { ChainBankError } from '../../../../src/domain/errors.js';

const replenishPrelude = vi.hoisted(() => ({
  replenishOperationalPrelude: vi.fn<
    (
      dependencies: unknown,
      input: { readonly evmChainId: number; readonly idempotencyKey: string },
    ) => Promise<void>
  >(() => Promise.resolve()),
}));

vi.mock('../../../../src/app/funding/replenish-operational-prelude.js', () => ({
  replenishOperationalPrelude: replenishPrelude.replenishOperationalPrelude,
}));
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
  TreasuryOutgoingScanner,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
import { classifyReconciliationRun } from '../../../../src/app/alerts/notify-reconciliation-failure.js';
import { classifyReconcilerExit, reconcilerExitCode } from '../../../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createTreasuryOutgoingScanner } from '../../../../src/infrastructure/evm/treasury-outgoing-scanner.js';
import { createFixedClock } from '../../../support/clock.js';
import {
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
  createInMemoryFundingStores,
  createInMemoryReconciliationFundingQuery,
  createInMemoryReconciliationRunRepository,
  createTestChainAdapterRegistry,
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

function countingRpc(options: {
  readonly tip: bigint;
  readonly countAt: (blockNumber: bigint) => number;
  readonly unavailableAt?: bigint;
}): {
  readonly scanner: TreasuryOutgoingScanner;
  readonly getBlockCount: number;
  readonly countBlocks: readonly bigint[];
} {
  const counts = { getBlock: 0, countBlocks: [] as bigint[] };
  let now = 0;
  const transport: Transport = custom(
    {
      request({ method, params }) {
        switch (method) {
          case 'eth_chainId':
            return Promise.resolve('0xaa36a7');
          case 'eth_blockNumber':
            return Promise.resolve(`0x${options.tip.toString(16)}`);
          case 'eth_getTransactionCount': {
            const blockTag = (params as [string, string])[1];
            const blockNumber = BigInt(blockTag);
            counts.countBlocks.push(blockNumber);
            if (options.unavailableAt === blockNumber) {
              return Promise.reject(new Error('edge unavailable'));
            }
            return Promise.resolve(`0x${options.countAt(blockNumber).toString(16)}`);
          }
          case 'eth_getBlockByNumber': {
            counts.getBlock += 1;
            const blockNumber = BigInt((params as [string, boolean])[0]);
            return Promise.resolve({
              number: `0x${blockNumber.toString(16)}`,
              hash: `0x${'11'.repeat(32)}`,
              timestamp: '0x1',
              transactions: [],
            });
          }
          default:
            return Promise.reject(new Error(`Unhandled RPC method in test transport: ${method}`));
        }
      },
    },
    { retryCount: 0 },
  );
  const scanner = createTreasuryOutgoingScanner({
    chain: {
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://rpc.example.test/sepolia',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
    maxRequestsPerSecond: 1_000,
    transport,
    nowMs: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  });
  return {
    scanner,
    get getBlockCount() {
      return counts.getBlock;
    },
    countBlocks: counts.countBlocks,
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
    kind: 'external',
    policy: undefined,
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

  it('emits a distinct fund-attribution log line per funded wallet (defeats amount-timing correlation)', async () => {
    const sink = collectLogs();
    const first = buildWallet('w-1', WALLET_A, { role: 'fortel2-batcher' });
    const second = buildWallet('w-2', WALLET_B, { role: 'chainbank-relayer' });
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A]: 0n,
        [WALLET_B]: 0n,
      },
    });
    const deps = buildDeps(stores, [first, second], buildTreasury(), {
      signer,
      balanceReader,
      logger: createLogger({
        level: 'info',
        serviceRole: 'cron-reconciler',
        environment: 'test',
        destination: sink.stream,
      }),
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-two-fund',
      runId: 'run-two-fund',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.counters.funded).toBe(2);
    expect(signer.sendCalls).toBe(2);

    const fundLines = sink.lines().filter((line) => line.event === 'reconciliation.wallet_funded');
    expect(fundLines).toHaveLength(2);

    const addresses = fundLines.map((line) => line.address);
    expect(addresses).toContain(WALLET_A);
    expect(addresses).toContain(WALLET_B);
    expect(new Set(addresses).size).toBe(2);

    for (const line of fundLines) {
      expect(typeof line.amountWei).toBe('string');
      expect(typeof line.balanceWei).toBe('string');
      expect(typeof line.transactionHash).toBe('string');
      expect(line.chainId).toBe(11_155_111);
      expect(line.walletId === 'w-1' || line.walletId === 'w-2').toBe(true);
      expect(line.walletLabel === 'fortel2-batcher' || line.walletLabel === 'chainbank-relayer').toBe(true);
      expect(() => JSON.stringify(line)).not.toThrow();
    }
  });

  it('emits blocked attribution lines when reserve stops funding', async () => {
    const sink = collectLogs();
    const first = buildWallet('w-1', WALLET_A);
    const second = buildWallet('w-2', WALLET_B);
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
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
      logger: createLogger({
        level: 'info',
        serviceRole: 'cron-reconciler',
        environment: 'test',
        destination: sink.stream,
      }),
    });

    await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-block-attr',
      runId: 'run-block-attr',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = sink.lines().filter((line) => line.event === 'reconciliation.wallet_blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked.map((line) => line.address).sort()).toEqual([WALLET_A, WALLET_B].sort());
  });

  it('persists funding_operations for reserve-stop wallets that never reach dispatch', async () => {
    // Finding 2: second wallet is blocked by the in-run reserve-stop pre-check
    // (no dispatchFunding call) and must still get a durable attempt row.
    const first = buildWallet('w-1', WALLET_A);
    const second = buildWallet('w-2', WALLET_B);
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
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

    await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-block-durable',
      runId: 'run-block-durable',
    });

    const ops = [...stores.opsById.values()];
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.idempotencyKey).sort()).toEqual([
      'reconcile:run-block-durable:w-1',
      'reconcile:run-block-durable:w-2',
    ]);
    for (const op of ops) {
      expect(op.status).toBe('failed');
      expect(op.errorCode).toBe('FUNDING_BLOCKED_RESERVE');
      expect(op.requestedBy).toBe('cron-cred');
    }
    expect(signer.sendCalls).toBe(0);
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
      ...buildDeps(stores, [], buildTreasury(), { omitSigner: true }),
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
    // Finding notify uses findOpenOrAcknowledgedByEntity (C20 dedupe); stub that path.
    deps.alerts.findOpenOrAcknowledgedByEntity = () => Promise.reject(new Error('finding alert store down'));

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
    const originalFind = alerts.findOpenOrAcknowledgedByEntity.bind(alerts);
    alerts.findOpenOrAcknowledgedByEntity = (entityType, entityId, alertType) => {
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
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      countAtBlock: (blockNumber) => (blockNumber >= 1_050n ? 1 : 0),
    });
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
      scannedNonce: 1,
      scannedAt: now,
    });
    expect(result.outgoingScanStatus).toBe('complete');
  });

  it('uses a tip-relative capped window when no marker exists', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 50_000n,
      // Null nonce with equal edges would skip (TX.34). A rise at the tip
      // keeps this test on the body scan that proves the capped window.
      countAtBlock: (blockNumber) => (blockNumber >= 50_000n ? 1 : 0),
    });
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
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 50_000n,
      countAtBlock: (blockNumber) => (blockNumber >= 21_000n ? 1 : 0),
    });
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
      countAtBlock: (blockNumber) => (blockNumber >= 21_000n ? 1 : 0),
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

    // A TX.14 skip is a zero-finding complete scan, so TX.34 persists the
    // watermark before markFinished. A later failure cannot undo a window
    // that was proved empty.
    expect(scanner.listCalls).toHaveLength(0);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 1_050n,
      scannedNonce: 7,
      scannedAt: now,
    });
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
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 2_000n,
      countAtBlock: (blockNumber) => (blockNumber >= 2_000n ? 1 : 0),
    });
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

    const noSigner = buildDeps(stores, [], buildTreasury(), { omitSigner: true });
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
      destinationTreasuryId: undefined,
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

  it('settles replenish submission_unknown when the transfer matches the operational treasury', async () => {
    const stores = createInMemoryFundingStores();
    const operationalAddress = '0x3333333333333333333333333333333333333333';
    const amountWei = ONE_ETH / 2n;
    const unknown: FundingTransaction = {
      id: 'tx-replenish-unknown',
      operationId: 'op-replenish-unknown',
      treasuryId: 'treasury-1',
      managedWalletId: undefined,
      destinationTreasuryId: 'treasury-operational',
      transactionHash: undefined,
      nonce: 5,
      amountWei,
      status: 'submission_unknown',
      errorCode: 'RPC_UNAVAILABLE',
      submittedAt: undefined,
      confirmedAt: undefined,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    stores.txsById.set(unknown.id, unknown);
    await stores.operations.insertPending({
      id: unknown.operationId,
      operationType: 'replenish_operational',
      projectId: undefined,
      environmentId: undefined,
      idempotencyKey: undefined,
      requestedBy: 'cron-cred',
      startedAt: unknown.createdAt,
    });

    const hash = `0x${'aa'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      confirmedNonce: 6,
      findByNonce: () => ({
        kind: 'found',
        transfer: {
          transactionHash: hash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: operationalAddress,
          valueWei: amountWei,
          nonce: 5,
          blockNumber: 100n,
        },
      }),
      latestBlockNumber: 1_000n,
    });
    const deps = buildDeps(stores, [], buildTreasury(), {
      outgoingScanner: scanner,
      outgoingLookbackBlocks: 100n,
    });
    deps.treasuries.findById = vi.fn((id: string) =>
      Promise.resolve(
        id === 'treasury-operational'
          ? buildTreasury({
              id: 'treasury-operational',
              kind: 'operational',
              address: operationalAddress.toLowerCase(),
              addressDisplay: operationalAddress,
            })
          : undefined,
      ),
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-replenish-unknown',
      runId: 'run-replenish-unknown',
    });

    expect(result.submissionUnknownResolved).toBe(1);
    expect(result.submissionUnknownLeftPending).toBe(0);
    expect(stores.txsById.get(unknown.id)?.status).toBe('confirmed');
    expect(stores.txsById.get(unknown.id)?.transactionHash).toBe(hash);
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

  it('full-scans when stored nonce is null and the edge counts differ, records nonce, then skips on the next run', async () => {
    const stores = createInMemoryFundingStores();
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      countAtBlock: (blockNumber) => (blockNumber >= 1_050n ? 4 : 3),
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

  it('does not advance the watermark when an unexplained transfer is found and markFinished fails', async () => {
    const stores = createInMemoryFundingStores();
    const orphanHash = `0x${'cc'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      latestBlockNumber: 1_050n,
      countAtBlock: (blockNumber) => (blockNumber >= 1_050n ? 5 : 4),
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A,
          valueWei: ONE_ETH / 2n,
          nonce: 4,
          blockNumber: 1_025n,
        },
      ],
    });
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 1_000n,
        lastOutgoingScanNonce: undefined,
      }),
      { outgoingScanner: scanner },
    );
    deps.reconciliationRuns.markFinished = () => Promise.reject(new Error('forced markFinished failure'));

    await expect(
      reconcileWallets(deps, {
        role: 'cron-reconciler',
        credentialId: 'cron-cred',
        correlationId: 'corr-finding-mark-fail',
        runId: 'run-finding-mark-fail',
      }),
    ).rejects.toThrow('forced markFinished failure');

    expect(scanner.listCalls).toHaveLength(1);
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('skips a null stored nonce when edge counts match and issues zero getBlock calls', async () => {
    const rpc = countingRpc({
      tip: 14n,
      countAt: () => 4,
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 10n,
        lastOutgoingScanNonce: undefined,
      }),
      { outgoingScanner: rpc.scanner, outgoingLookbackBlocks: 100n },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-null-equal',
      runId: 'run-null-equal',
    });

    expect(rpc.getBlockCount).toBe(0);
    expect(rpc.countBlocks).toEqual([10n, 14n]);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith({
      treasuryId: 'treasury-1',
      scannedToBlock: 14n,
      scannedNonce: 4,
      scannedAt: now,
    });
    expect(result.outgoingScanStatus).toBe('complete');
  });

  it('body-scans a null stored nonce when edge counts differ, one getBlock per block', async () => {
    const rpc = countingRpc({
      tip: 14n,
      countAt: (blockNumber) => (blockNumber >= 14n ? 6 : 4),
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 10n,
        lastOutgoingScanNonce: undefined,
      }),
      { outgoingScanner: rpc.scanner, outgoingLookbackBlocks: 100n },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-null-unequal',
      runId: 'run-null-unequal',
    });

    // Window is [11, 14].
    expect(rpc.getBlockCount).toBe(4);
    expect(result.outgoingScanStatus).toBe('complete');
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 14n, scannedNonce: 6 }),
    );
  });

  it('leaves the watermark unchanged when a null-nonce edge read is unavailable', async () => {
    const rpc = countingRpc({
      tip: 14n,
      countAt: () => 4,
      unavailableAt: 10n,
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(
      stores,
      [],
      buildTreasury({
        lastOutgoingScanBlock: 10n,
        lastOutgoingScanNonce: undefined,
      }),
      { outgoingScanner: rpc.scanner, outgoingLookbackBlocks: 100n },
    );

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-null-unavailable',
      runId: 'run-null-unavailable',
    });

    expect(rpc.getBlockCount).toBe(0);
    expect(rpc.countBlocks).toEqual([10n]);
    expect(result.outgoingScanStatus).toBe('incomplete');
    expect(result.findings.some((finding) => finding.kind === 'outgoing_scan_incomplete')).toBe(true);
    expect(deps.treasuries.recordOutgoingScanComplete).not.toHaveBeenCalled();
  });

  it('body-scans from block zero and does not read a count below zero', async () => {
    const rpc = countingRpc({
      tip: 3n,
      countAt: () => 0,
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [], buildTreasury({ lastOutgoingScanNonce: undefined }), {
      outgoingScanner: rpc.scanner,
      outgoingLookbackBlocks: 100n,
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-null-genesis',
      runId: 'run-null-genesis',
    });

    expect(rpc.countBlocks.some((block) => block < 0n)).toBe(false);
    expect(rpc.getBlockCount).toBe(4);
    expect(result.outgoingScanStatus).toBe('complete');
  });
});

describe('reconcileWallets replenish prelude and C23 findings (P6-PREP-3)', () => {
  const BASE_SEPOLIA_CHAIN_ID = 84_532;

  beforeEach(() => {
    replenishPrelude.replenishOperationalPrelude.mockReset();
    replenishPrelude.replenishOperationalPrelude.mockResolvedValue(undefined);
  });

  it('uses a chain-scoped prelude key for each unique wallet chain', async () => {
    const sepolia = buildWallet('w-sepolia', WALLET_A);
    const other = buildWallet('w-84532', WALLET_B, {
      chain: {
        id: 'chain-84532',
        slug: 'fixture-84532',
        chainId: BASE_SEPOLIA_CHAIN_ID,
        displayName: 'Fixture 84532',
        nativeSymbol: 'ETH',
        explorerBaseUrl: 'https://sepolia.etherscan.io',
      },
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [sepolia, other], buildTreasury(), {
      externalSigner: createFakeSigner({}),
      extraChainIds: [BASE_SEPOLIA_CHAIN_ID],
    });

    await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-prelude-keys',
      runId: 'run-two-chains',
    });

    const keys = replenishPrelude.replenishOperationalPrelude.mock.calls.map(([, input]) => ({
      evmChainId: input.evmChainId,
      idempotencyKey: input.idempotencyKey,
    }));
    expect(keys).toEqual([
      { evmChainId: 11_155_111, idempotencyKey: 'reconcile:run-two-chains:chain:11155111' },
      { evmChainId: BASE_SEPOLIA_CHAIN_ID, idempotencyKey: 'reconcile:run-two-chains:chain:84532' },
    ]);
  });

  it('does not treat two-tier (one external + one operational) as ambiguous', async () => {
    const wallet = buildWallet('w-below', WALLET_A);
    const external = buildTreasury({ id: 'treasury-external' });
    const operational = buildTreasury({
      id: 'treasury-operational',
      address: '0x3333333333333333333333333333333333333333'.toLowerCase(),
      addressDisplay: '0x3333333333333333333333333333333333333333',
      kind: 'operational',
      policy: {
        minimumBalanceWei: ONE_ETH,
        targetBalanceWei: 2n * ONE_ETH,
        maximumTopUpWei: 5n * ONE_ETH,
      },
    });
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: operational.addressDisplay });
    const deps = buildDeps(stores, [wallet], operational, {
      signer,
      balanceReader: createFakeBalanceReader({
        balances: {
          [TREASURY_ADDRESS]: 20n * ONE_ETH,
          [operational.addressDisplay]: 20n * ONE_ETH,
          [WALLET_A]: ONE_ETH / 10n,
        },
      }),
    });
    deps.treasuries.listEnabled = () => Promise.resolve([external, operational]);

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-two-tier',
      runId: 'run-two-tier',
    });

    expect(
      result.findings.filter(
        (finding) => finding.kind === 'wallet_assessment_failed' && finding.reason.includes('Ambiguous'),
      ),
    ).toEqual([]);
    expect(result.counters.funded).toBe(1);
    expect(signer.sendCalls).toBe(1);
  });

  it('uses the C23 per-kind message when two enabled treasuries share a kind', async () => {
    const wallet = buildWallet('w-1', WALLET_A);
    const first = buildTreasury({ id: 'treasury-ext-1' });
    const second = buildTreasury({
      id: 'treasury-ext-2',
      address: '0x4444444444444444444444444444444444444444'.toLowerCase(),
      addressDisplay: '0x4444444444444444444444444444444444444444',
    });
    const stores = createInMemoryFundingStores();
    const deps = buildDeps(stores, [wallet], first);
    deps.treasuries.listEnabled = () => Promise.resolve([first, second]);

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-ambiguous-kind',
      runId: 'run-ambiguous-kind',
    });

    const assessment = result.findings.find((finding) => finding.kind === 'wallet_assessment_failed');
    expect(assessment?.reason).toContain('Ambiguous external treasury configuration for chain 11155111');
    expect(assessment?.reason).toContain('2 enabled rows');
    expect(result.counters.failed).toBe(1);
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
    findOpenOrAcknowledgedByEntity(entityType, entityId, alertType) {
      const open = [...rows.values()].find(
        (row) => row.entityType === entityType && row.entityId === entityId && row.alertType === alertType,
      );
      if (open === undefined) {
        return Promise.resolve(undefined);
      }
      // Working fake only stores open rows; preference rule is open-first (C20).
      return Promise.resolve({
        ...open,
        state: 'open' as const,
        resolvedAt: undefined,
        acknowledgedAt: undefined,
        acknowledgedBy: undefined,
        acknowledgementNote: undefined,
      });
    },
    findById() {
      return Promise.resolve(undefined);
    },
    list() {
      return Promise.resolve({ items: [], total: 0 });
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
    recordOperatorAcknowledgement() {
      return Promise.reject(new Error('unused'));
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
    /** Explicit read-only process: no signer is registered. */
    readonly omitSigner?: boolean;
    readonly externalSigner?: ReturnType<typeof createFakeSigner>;
    readonly extraChainIds?: readonly number[];
    readonly balanceReader?: ReturnType<typeof createFakeBalanceReader>;
    readonly outgoingScanner?: TreasuryOutgoingScanner;
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
    findOpenOrAcknowledgedByEntity: () => Promise.resolve(undefined),
    findById: () => Promise.resolve(undefined),
    list: () => Promise.resolve({ items: [], total: 0 }),
    insertOpen: vi.fn(),
    markEscalated: vi.fn(),
    markPendingEmail: vi.fn(),
    clearPendingEmail: vi.fn(),
    acknowledgeSend: vi.fn(),
    recordOperatorAcknowledgement: vi.fn(),
    resolve: vi.fn(),
    touchLastEvaluated: vi.fn(),
  };

  const balanceReader =
    overrides.balanceReader ??
    createFakeBalanceReader({
      balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH },
    });
  const outgoingScanner = overrides.outgoingScanner ?? createFakeOutgoingScanner();
  const receiptTracker = createFakeReceiptTracker({
    kind: 'confirmed',
    confirmedAt: now,
  });
  const signer =
    overrides.omitSigner === true
      ? undefined
      : (overrides.signer ?? createFakeSigner({ address: TREASURY_ADDRESS }));

  return {
    managedWallets,
    treasuries,
    balanceObservations,
    chainAdapters: createTestChainAdapterRegistry({
      balanceReader,
      outgoingScanner,
      receiptTracker,
      ...(signer === undefined ? {} : { signer }),
      ...(overrides.externalSigner === undefined ? {} : { externalSigner: overrides.externalSigner }),
      extraChains: (overrides.extraChainIds ?? []).map((chainId) => ({
        chainId,
        ...(overrides.externalSigner === undefined
          ? {}
          : {
              externalSigner: createFakeSigner({
                chainId,
                address: overrides.externalSigner.address,
              }),
            }),
      })),
    }),
    auditEvents,
    alerts,
    emailSender: undefined,
    operations: stores.operations,
    transactions: stores.transactions,
    reconciliationRuns: createInMemoryReconciliationRunRepository(),
    reconciliationFunding: createInMemoryReconciliationFundingQuery(stores.txsById),
    lock: stores.lock,
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

describe('reconcileWallets per-chain isolation (C29)', () => {
  const BASE_CHAIN_ID = 84_532;
  const BASE_TREASURY = '0x9999999999999999999999999999999999999999';

  function baseChain() {
    return {
      id: 'chain-base',
      slug: 'base-sepolia',
      chainId: BASE_CHAIN_ID,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.basescan.org',
    };
  }

  beforeEach(() => {
    replenishPrelude.replenishOperationalPrelude.mockReset();
    replenishPrelude.replenishOperationalPrelude.mockImplementation((_dependencies, input) => {
      if (input.evmChainId === BASE_CHAIN_ID) {
        return Promise.reject(
          new ChainBankError('RPC_UNAVAILABLE', 'base rpc down', {
            publicMessage: 'The chain is unavailable.',
          }),
        );
      }
      return Promise.resolve();
    });
  });

  it('funds the healthy chain when another chain RPC fails and does not classify success', async () => {
    const sepoliaWallet = buildWallet('w-sepolia', WALLET_A);
    const baseWallet = buildWallet('w-base', WALLET_B, { chain: baseChain() });
    const sepoliaTreasury = buildTreasury({ id: 'treasury-sepolia' });
    const baseTreasury = buildTreasury({
      id: 'treasury-base',
      address: BASE_TREASURY.toLowerCase(),
      addressDisplay: BASE_TREASURY,
      chain: baseChain(),
    });
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A]: ONE_ETH / 10n,
      },
    });
    const resolveAlert = vi.fn();
    const deps = buildDeps(stores, [sepoliaWallet, baseWallet], sepoliaTreasury, {
      signer,
      balanceReader,
      externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
    });
    const isolated = {
      ...deps,
      treasuries: {
        ...deps.treasuries,
        listEnabled: () => Promise.resolve([sepoliaTreasury, baseTreasury]),
      },
      alerts: {
        ...deps.alerts,
        findOpenByEntity: (entityType: string, entityId: string) =>
          Promise.resolve(
            entityId === baseTreasury.id
              ? {
                  id: 'alert-base',
                  alertType: 'reconciliation_failure',
                  severity: 'critical' as const,
                  entityType,
                  entityId,
                  firstTriggeredAt: now,
                  lastEvaluatedAt: now,
                  lastSentAt: now,
                  pendingEmail: undefined,
                  metadata: {},
                }
              : undefined,
          ),
        resolve: resolveAlert,
      },
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader,
        signer,
        outgoingScanner: createFakeOutgoingScanner(),
        externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
        extraChains: [
          {
            chainId: BASE_CHAIN_ID,
            balanceReader: createFakeBalanceReader({
              chainId: BASE_CHAIN_ID,
              unavailable: {
                [BASE_TREASURY]: 'RPC_UNAVAILABLE',
                [WALLET_B]: 'RPC_UNAVAILABLE',
              },
            }),
            outgoingScanner: createFakeOutgoingScanner({
              latestBlockUnavailable: { errorCode: 'RPC_UNAVAILABLE', reason: 'base tip down' },
            }),
            signer: createFakeSigner({ chainId: BASE_CHAIN_ID, address: BASE_TREASURY }),
            externalSigner: createFakeSigner({ chainId: BASE_CHAIN_ID, address: BASE_TREASURY }),
          },
        ],
      }),
    };

    const result = await reconcileWallets(isolated, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-isolate',
      runId: 'run-isolate',
    });

    expect(signer.sendCalls).toBe(1);
    expect(result.counters.funded).toBe(1);
    expect(result.counters.assessed).toBe(1);
    expect(result.run.errorCode).toBeUndefined();
    const outcomes = result.run.findings.filter((finding) => finding.kind === 'chain_outcome');
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chainId: 11_155_111, status: 'processed' }),
        expect.objectContaining({ chainId: BASE_CHAIN_ID, status: 'unavailable' }),
      ]),
    );
    expect(classifyReconciliationRun(result.run)).toBe('failure');
    expect(
      classifyReconcilerExit(
        result.run.errorCode,
        outcomes.flatMap((finding) =>
          finding.kind === 'chain_outcome'
            ? [
                {
                  chainId: finding.chainId,
                  status: finding.status,
                  errorCode: finding.errorCode,
                  reason: finding.reason,
                },
              ]
            : [],
        ),
      ),
    ).toBe('malfunction');
    expect(reconcilerExitCode('malfunction')).toBe(1);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('keeps a single-chain RPC throw as a run-level error', async () => {
    replenishPrelude.replenishOperationalPrelude.mockReset();
    replenishPrelude.replenishOperationalPrelude.mockRejectedValue(
      new ChainBankError('RPC_UNAVAILABLE', 'rpc down', { publicMessage: 'The chain is unavailable.' }),
    );
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const deps = buildDeps(stores, [buildWallet('w-only', WALLET_A)], buildTreasury(), {
      signer,
      balanceReader: createFakeBalanceReader({
        balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A]: 0n },
      }),
      externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
    });

    const result = await reconcileWallets(deps, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-single-down',
      runId: 'run-single-down',
    });

    expect(signer.sendCalls).toBe(0);
    expect(result.run.errorCode).toBe('RPC_UNAVAILABLE');
    expect(classifyReconciliationRun(result.run)).toBe('failure');
    expect(classifyReconcilerExit(result.run.errorCode)).toBe('malfunction');
  });

  it('keeps a run-level error when every configured chain is unavailable', async () => {
    replenishPrelude.replenishOperationalPrelude.mockReset();
    replenishPrelude.replenishOperationalPrelude.mockRejectedValue(
      new ChainBankError('RPC_UNAVAILABLE', 'rpc down', { publicMessage: 'The chain is unavailable.' }),
    );
    const sepoliaWallet = buildWallet('w-sepolia', WALLET_A);
    const baseWallet = buildWallet('w-base', WALLET_B, { chain: baseChain() });
    const sepoliaTreasury = buildTreasury({ id: 'treasury-sepolia' });
    const baseTreasury = buildTreasury({
      id: 'treasury-base',
      address: BASE_TREASURY.toLowerCase(),
      addressDisplay: BASE_TREASURY,
      chain: baseChain(),
    });
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const deps = buildDeps(stores, [sepoliaWallet, baseWallet], sepoliaTreasury, {
      signer,
      balanceReader: createFakeBalanceReader({
        balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A]: 0n },
      }),
      externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
    });
    const bothDown = {
      ...deps,
      treasuries: {
        ...deps.treasuries,
        listEnabled: () => Promise.resolve([sepoliaTreasury, baseTreasury]),
      },
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader: createFakeBalanceReader({
          balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A]: 0n },
        }),
        signer,
        outgoingScanner: createFakeOutgoingScanner(),
        externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
        extraChains: [
          {
            chainId: BASE_CHAIN_ID,
            balanceReader: createFakeBalanceReader({ chainId: BASE_CHAIN_ID }),
            outgoingScanner: createFakeOutgoingScanner(),
            externalSigner: createFakeSigner({ chainId: BASE_CHAIN_ID, address: BASE_TREASURY }),
          },
        ],
      }),
    };

    const result = await reconcileWallets(bothDown, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-all-down',
      runId: 'run-all-down',
    });

    expect(replenishPrelude.replenishOperationalPrelude).toHaveBeenCalledTimes(2);
    expect(signer.sendCalls).toBe(0);
    expect(result.run.errorCode).toBe('RPC_UNAVAILABLE');
    expect(classifyReconciliationRun(result.run)).toBe('failure');
    expect(classifyReconcilerExit(result.run.errorCode)).toBe('malfunction');
    expect(reconcilerExitCode('malfunction')).toBe(1);
  });

  it('records processed-with-failures when a returned funding attempt fails', async () => {
    const stores = createInMemoryFundingStores();
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A]: 0n },
    });
    const deps = buildDeps(stores, [buildWallet('w-fail', WALLET_A)], buildTreasury(), {
      signer,
      balanceReader,
      externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
    });
    const withRevertedReceipt = {
      ...deps,
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader,
        signer,
        outgoingScanner: createFakeOutgoingScanner(),
        receiptTracker: createFakeReceiptTracker({ kind: 'reverted' }),
        externalSigner: createFakeSigner({ address: TREASURY_ADDRESS }),
      }),
    };

    const result = await reconcileWallets(withRevertedReceipt, {
      role: 'cron-reconciler',
      credentialId: 'cron-cred',
      correlationId: 'corr-item-failed',
      runId: 'run-item-failed',
    });

    expect(result.counters.failed).toBe(1);
    expect(result.counters.funded).toBe(0);
    expect(result.run.errorCode).toBeUndefined();
    expect(result.run.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'chain_outcome',
          chainId: 11_155_111,
          status: 'processed-with-failures',
        }),
      ]),
    );
    // A single chain with per-wallet failures still exits 0. C15 classifies
    // the run as failure from the counters, which is the pre-C29 rule.
    expect(classifyReconciliationRun(result.run)).toBe('failure');
    expect(classifyReconcilerExit(result.run.errorCode)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
  });
});
