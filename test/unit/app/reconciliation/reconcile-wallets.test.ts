import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { reconcileWallets } from '../../../../src/app/reconciliation/reconcile-wallets.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  FundingTransaction,
  ManagedWallet,
  ManagedWalletRepository,
  RecordOutgoingScanCompleteInput,
  Treasury,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
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

  it('records coverage-behind when the gap exceeds the cap and still advances only to the scanned tip', async () => {
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

    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 30_000n, toBlock: 50_000n });
    expect(result.findings.some((f) => f.kind === 'outgoing_scan_coverage_behind')).toBe(true);
    expect(deps.treasuries.recordOutgoingScanComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scannedToBlock: 50_000n }),
    );
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
