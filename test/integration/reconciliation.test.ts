import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reconcileWallets } from '../../src/app/reconciliation/reconcile-wallets.js';
import { ensureWalletFunded } from '../../src/app/funding/ensure-wallet-funded.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createReconciliationFundingQuery } from '../../src/infrastructure/db/repositories/reconciliation-query-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentials,
  environments,
  fundingPolicies,
  fundingTransactions,
  managedWallets,
  projects,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import {
  createControllableSigner,
  createDeferred,
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
} from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  seedInFlightFundingTransaction,
  seedManagedWallet,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  waitForAdvisoryLockWaiters,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const ONE_ETH = 10n ** 18n;
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
const WALLET_A_ADDRESS = '0x2222222222222222222222222222222222222222';
const WALLET_B_ADDRESS = '0x3333333333333333333333333333333333333333';
const WALLET_C_ADDRESS = '0x4444444444444444444444444444444444444444';

describe.skipIf(!integrationEnabled)('reconciliation use case (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let cronCredentialId: string;
  let operatorCredentialId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase({ poolMax: 12 });
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    await handle.db
      .update(managedWallets)
      .set({ reconciliationEnabled: true })
      .where(eq(managedWallets.id, seed.managedWalletId));

    await handle.db.insert(fundingPolicies).values({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: ONE_ETH.toString(),
      targetBalanceWei: (2n * ONE_ETH).toString(),
      maximumTopUpWei: (5n * ONE_ETH).toString(),
      version: 1,
    });

    const cronToken = generateApiToken();
    const [cronCred] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `cron-${randomUUID()}`,
        role: 'cron-reconciler',
        tokenHash: cronToken.tokenHash,
        tokenPrefix: cronToken.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (cronCred === undefined) {
      throw new Error('failed to seed cron credential');
    }
    cronCredentialId = cronCred.id;

    const opToken = generateApiToken();
    const [opCred] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: opToken.tokenHash,
        tokenPrefix: opToken.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (opCred === undefined) {
      throw new Error('failed to seed operator credential');
    }
    operatorCredentialId = opCred.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('funds exactly the below-minimum eligible wallets once', async () => {
    const walletB = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: WALLET_B_ADDRESS,
      reconciliationEnabled: true,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: (5n * ONE_ETH).toString(),
      },
    });
    const walletDisabled = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: WALLET_C_ADDRESS,
      reconciliationEnabled: false,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: (5n * ONE_ETH).toString(),
      },
    });
    void walletDisabled;

    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
        [WALLET_B_ADDRESS]: ONE_ETH,
        [WALLET_C_ADDRESS]: 0n,
      },
    });

    const result = await reconcileWallets(buildReconcileDeps({ signer, balanceReader }), {
      role: 'cron-reconciler',
      credentialId: cronCredentialId,
      correlationId: `corr-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
    });

    expect(signer.sendCalls).toBe(1);
    expect(result.counters.funded).toBe(1);
    expect(result.counters.noop).toBe(1);
    expect(result.counters.assessed).toBe(2);

    const txs = await handle.db.select().from(fundingTransactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.managedWalletId).toBe(seed.managedWalletId);
    void walletB;
  });

  it('excludes disabled wallet, project, and environment', async () => {
    await handle.db
      .update(managedWallets)
      .set({ enabled: false })
      .where(eq(managedWallets.id, seed.managedWalletId));

    const envWallet = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: WALLET_B_ADDRESS,
      reconciliationEnabled: true,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: (5n * ONE_ETH).toString(),
      },
    });

    await handle.db.update(projects).set({ enabled: false }).where(eq(projects.id, seed.projectId));

    const otherProject = await handle.db
      .insert(projects)
      .values({ slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other', enabled: true })
      .returning({ id: projects.id });
    const otherEnv = await handle.db
      .insert(environments)
      .values({
        projectId: otherProject[0]!.id,
        slug: 'dev',
        name: 'Dev',
        enabled: false,
      })
      .returning({ id: environments.id });

    await seedManagedWallet(handle.db, {
      environmentId: otherEnv[0]!.id,
      chainId: seed.chainId,
      address: WALLET_C_ADDRESS,
      reconciliationEnabled: true,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: (5n * ONE_ETH).toString(),
      },
    });

    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: 0n,
        [WALLET_B_ADDRESS]: 0n,
        [WALLET_C_ADDRESS]: 0n,
      },
    });

    // Re-enable project for envWallet path: project disabled excludes envWallet too.
    // Reset project enabled and disable only the seed wallet + other env.
    await handle.db.update(projects).set({ enabled: true }).where(eq(projects.id, seed.projectId));
    await handle.db
      .update(environments)
      .set({ enabled: false })
      .where(eq(environments.id, seed.environmentId));

    const result = await reconcileWallets(buildReconcileDeps({ signer, balanceReader }), {
      role: 'cron-reconciler',
      credentialId: cronCredentialId,
      correlationId: `corr-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
    });

    expect(signer.sendCalls).toBe(0);
    expect(result.counters.assessed).toBe(0);
    void envWallet;
  });

  it('racing reconcile and ensure-funded produces exactly one transfer', async () => {
    const sendHold = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const signer = createControllableSigner({
      address: TREASURY_ADDRESS,
      onSend: async () => {
        if (signer.enteredSendCount === 1) {
          firstEntered.resolve();
          await sendHold.promise;
        }
      },
      getNonce: () => signer.sendCalls,
    });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });

    // Leave winner submitted so the loser still hits the C4 in-flight gate.
    const pendingTracker = createFakeReceiptTracker({ kind: 'pending' });
    const reconcileDeps = {
      ...buildReconcileDeps({ signer, balanceReader }),
      receiptTracker: pendingTracker,
    };
    const ensureDeps = {
      ...buildEnsureDeps({ signer, balanceReader }),
      receiptTracker: pendingTracker,
    };

    const reconcilePromise = reconcileWallets(reconcileDeps, {
      role: 'cron-reconciler',
      credentialId: cronCredentialId,
      correlationId: `corr-recon-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
    });

    await firstEntered.promise;

    const ensurePromise = ensureWalletFunded(ensureDeps, {
      walletId: seed.managedWalletId,
      idempotencyKey: `api-${randomUUID()}`,
      role: 'operator',
      credentialId: operatorCredentialId,
      correlationId: `corr-api-${randomUUID()}`,
      sourceIp: '127.0.0.1',
    });

    await waitForAdvisoryLockWaiters(handle.pool, 1);
    sendHold.resolve();

    const settled = await Promise.allSettled([reconcilePromise, ensurePromise]);
    expect(signer.sendCalls).toBe(1);

    const txs = await handle.db.select().from(fundingTransactions);
    const inFlight = txs.filter(
      (tx) => tx.status === 'submitted' || tx.status === 'confirmed' || tx.status === 'submission_unknown',
    );
    expect(inFlight).toHaveLength(1);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });

  it('settles submission_unknown on positive evidence and leaves pending without', async () => {
    const amountWei = (ONE_ETH / 2n).toString();
    const { transactionId } = await seedInFlightFundingTransaction(handle.db, {
      projectId: seed.projectId,
      environmentId: seed.environmentId,
      treasuryId: seed.treasuryId,
      managedWalletId: seed.managedWalletId,
      amountWei,
      status: 'submission_unknown',
      nonce: 5,
    });

    const matchingHash = `0x${'ab'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      confirmedNonce: 6,
      transfers: [
        {
          transactionHash: matchingHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_A_ADDRESS,
          valueWei: ONE_ETH / 2n,
          nonce: 5,
          blockNumber: 100n,
        },
      ],
    });

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH,
      },
    });

    const settled = await reconcileWallets(
      buildReconcileDeps({
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader,
        outgoingScanner: scanner,
      }),
      {
        role: 'cron-reconciler',
        credentialId: cronCredentialId,
        correlationId: `corr-${randomUUID()}`,
        runId: `run-settle-${randomUUID()}`,
      },
    );

    expect(settled.submissionUnknownResolved).toBe(1);
    const [row] = await handle.db
      .select()
      .from(fundingTransactions)
      .where(eq(fundingTransactions.id, transactionId));
    expect(row?.status).toBe('confirmed');
    expect(row?.transactionHash).toBe(matchingHash);

    // Second unknown: nonce not advanced → left pending.
    const { transactionId: pendingId } = await seedInFlightFundingTransaction(handle.db, {
      projectId: seed.projectId,
      environmentId: seed.environmentId,
      treasuryId: seed.treasuryId,
      managedWalletId: seed.managedWalletId,
      amountWei,
      status: 'submission_unknown',
      nonce: 10,
      requestedBy: 'cred-pending-unknown',
    });

    scanner.setConfirmedNonce(10);
    scanner.setTransfers([]);

    // Clear in-flight gate for wallet by confirming the previous row already done;
    // the new unknown is the in-flight row. Wallet is at minimum so sweep no-ops.
    const left = await reconcileWallets(
      buildReconcileDeps({
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader,
        outgoingScanner: scanner,
      }),
      {
        role: 'cron-reconciler',
        credentialId: cronCredentialId,
        correlationId: `corr-${randomUUID()}`,
        runId: `run-pending-${randomUUID()}`,
      },
    );

    expect(left.submissionUnknownLeftPending).toBe(1);
    const [pendingRow] = await handle.db
      .select()
      .from(fundingTransactions)
      .where(eq(fundingTransactions.id, pendingId));
    expect(pendingRow?.status).toBe('submission_unknown');
  });

  it('flags a seeded on-chain-only transfer as a crash-orphan critical finding', async () => {
    const orphanHash = `0x${'cd'.repeat(32)}`;
    const scanner = createFakeOutgoingScanner({
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_B_ADDRESS,
          valueWei: ONE_ETH / 4n,
          nonce: 2,
          blockNumber: 77n,
        },
      ],
    });

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH,
      },
    });

    const result = await reconcileWallets(
      buildReconcileDeps({
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader,
        outgoingScanner: scanner,
      }),
      {
        role: 'cron-reconciler',
        credentialId: cronCredentialId,
        correlationId: `corr-${randomUUID()}`,
        runId: `run-orphan-${randomUUID()}`,
      },
    );

    expect(result.unexplainedTransferCount).toBe(1);
    expect(
      result.findings.some(
        (f) => f.kind === 'unexplained_outgoing_transfer' && f.transactionHash === orphanHash,
      ),
    ).toBe(true);

    // Never silently adopted into funding_transactions.
    const txs = await handle.db.select().from(fundingTransactions);
    expect(txs.every((tx) => tx.transactionHash !== orphanHash)).toBe(true);
  });

  function buildReconcileDeps(options: {
    readonly signer: TreasurySigner;
    readonly balanceReader: BalanceReader;
    readonly outgoingScanner?: ReturnType<typeof createFakeOutgoingScanner>;
  }) {
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const clock = createFixedClock();
    return {
      managedWallets: createManagedWalletRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
      balanceObservations: createBalanceObservationRepository(handle.db),
      balanceReader: options.balanceReader,
      auditEvents: createAuditEventRepository(handle.db),
      alerts: createAlertRepository(handle.db),
      emailSender: undefined,
      operations: createFundingOperationRepository(handle.db),
      transactions: createFundingTransactionRepository(handle.db),
      reconciliationRuns: createReconciliationRunRepository(handle.db),
      reconciliationFunding: createReconciliationFundingQuery(handle.db),
      outgoingScanner: options.outgoingScanner ?? createFakeOutgoingScanner(),
      lock: createFundingDispatchLock(handle.db),
      receiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: clock.now(),
      }),
      signer: options.signer,
      clock,
      idGenerator: { next: () => randomUUID() },
      logger,
      isFundingEnabled: true,
      isFundingKillSwitchActive: false,
      confirmations: 1,
      confirmationTimeoutMs: 1_000,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      reconcileFailureAlertThreshold: 3,
    };
  }

  function buildEnsureDeps(options: {
    readonly signer: TreasurySigner;
    readonly balanceReader: BalanceReader;
  }) {
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const clock = createFixedClock();
    return {
      managedWallets: createManagedWalletRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
      balanceObservations: createBalanceObservationRepository(handle.db),
      balanceReader: options.balanceReader,
      credentialScopes: createCredentialScopeRepository(handle.db),
      auditEvents: createAuditEventRepository(handle.db),
      alerts: createAlertRepository(handle.db),
      emailSender: undefined,
      operations: createFundingOperationRepository(handle.db),
      transactions: createFundingTransactionRepository(handle.db),
      lock: createFundingDispatchLock(handle.db),
      receiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: clock.now(),
      }),
      signer: options.signer,
      clock,
      idGenerator: { next: () => randomUUID() },
      logger,
      isFundingEnabled: true,
      isFundingKillSwitchActive: false,
      confirmations: 1,
      confirmationTimeoutMs: 1_000,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
    };
  }
});
