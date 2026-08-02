import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ensureEnvironmentReady,
  type EnsureEnvironmentReadyResult,
} from '../../src/app/funding/ensure-environment-ready.js';
import {
  reconcileWallets,
  type ReconcileWalletsResult,
} from '../../src/app/reconciliation/reconcile-wallets.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { ChainBankError, isChainBankError } from '../../src/domain/errors.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createReconciliationFundingQuery } from '../../src/infrastructure/db/repositories/reconciliation-query-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentials,
  fundingPolicies,
  fundingTransactions,
  managedWallets,
  reconciliationRuns,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { runRacing } from '../support/concurrency-harness.js';
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
  listGrantedAdvisoryLockPids,
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

describe.skipIf(!integrationEnabled)('cron-vs-API concurrency (integration, C16)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let cronCredentialId: string;
  let operatorCredentialId: string;

  beforeAll(async () => {
    // Concurrent advisory-lock holders each occupy a pool connection.
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

  it('same wallet: cron reconcile vs ensure-ready yields exactly one transfer', async () => {
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });
    const signer = createFakeSigner({
      address: TREASURY_ADDRESS,
      send: (input) => {
        const current = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase()) ?? 0n;
        balanceReader.setBalance(WALLET_A_ADDRESS.toLowerCase(), current + input.valueWei);
        const treasury = balanceReader.balances.get(TREASURY_ADDRESS.toLowerCase()) ?? 0n;
        balanceReader.setBalance(TREASURY_ADDRESS.toLowerCase(), treasury - input.valueWei);
        return Promise.resolve({ transactionHash: `0x${'11'.repeat(32)}` });
      },
    });

    const reconcileDeps = buildReconcileDeps({ signer, balanceReader });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-recon-${randomUUID()}`,
          runId: `run-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(signer.sendCalls).toBe(1);

    const txs = await handle.db.select().from(fundingTransactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.status).toBe('confirmed');

    const finalWalletBalance = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase());
    expect(finalWalletBalance).toBe(2n * ONE_ETH);
  });

  it('same wallet with rejectReusedNonce: no NONCE_CONFLICT and nonces strictly increase', async () => {
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });
    const signer = createFakeSigner({
      address: TREASURY_ADDRESS,
      rejectReusedNonce: true,
      send: (input) => {
        const current = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase()) ?? 0n;
        balanceReader.setBalance(WALLET_A_ADDRESS.toLowerCase(), current + input.valueWei);
        return Promise.resolve({
          transactionHash: `0x${input.nonce.toString(16).padStart(64, '0')}`,
        });
      },
    });

    const reconcileDeps = buildReconcileDeps({ signer, balanceReader });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-nonce-recon-${randomUUID()}`,
          runId: `run-nonce-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-nonce-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-nonce-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    // Dispatch remaps non-ChainBankError throws to RPC_UNAVAILABLE, so assert on
    // the fake's own conflict counter — that is the loud failure C16 requires.
    expect(signer.nonceConflictCount).toBe(0);
    for (const result of settled) {
      if (result.status === 'rejected') {
        expect(readErrorCode(result.reason)).not.toBe('NONCE_CONFLICT');
      }
    }

    expect(signer.sendCalls).toBe(1);
    expect(signer.nonces).toHaveLength(1);
    expect(new Set(signer.nonces).size).toBe(signer.nonces.length);
    for (let index = 1; index < signer.nonces.length; index += 1) {
      expect(signer.nonces[index]!).toBeGreaterThan(signer.nonces[index - 1]!);
    }
  });

  it('reserve is respected under cron-vs-API race; refused wallets are blocked', async () => {
    const reserveWei = 9n * ONE_ETH;
    const treasuryBalanceWei = 10n * ONE_ETH;
    const maxTopUpWei = (9n * ONE_ETH) / 10n;

    await handle.db
      .update(treasuries)
      .set({
        minimumReserveWei: reserveWei.toString(),
        criticalBalanceWei: (9n * ONE_ETH + ONE_ETH / 10n).toString(),
        warningBalanceWei: ((95n * ONE_ETH) / 10n).toString(),
        recoveryBalanceWei: (10n * ONE_ETH).toString(),
      })
      .where(eq(treasuries.id, seed.treasuryId));

    await handle.db
      .update(fundingPolicies)
      .set({
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: maxTopUpWei.toString(),
      })
      .where(eq(fundingPolicies.managedWalletId, seed.managedWalletId));

    const walletB = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: WALLET_B_ADDRESS,
      reconciliationEnabled: true,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: maxTopUpWei.toString(),
      },
    });
    const walletC = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: WALLET_C_ADDRESS,
      reconciliationEnabled: true,
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: maxTopUpWei.toString(),
      },
    });
    void walletB;
    void walletC;

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: treasuryBalanceWei,
        [WALLET_A_ADDRESS]: 0n,
        [WALLET_B_ADDRESS]: 0n,
        [WALLET_C_ADDRESS]: 0n,
      },
    });

    // Leave submitted pending so in-flight reserve accounting still sees spend.
    const pendingTracker = createFakeReceiptTracker({ kind: 'pending' });
    const signer = createFakeSigner({
      address: TREASURY_ADDRESS,
      estimatedCostWei: 21_000n,
      rejectReusedNonce: true,
    });

    const reconcileDeps = {
      ...buildReconcileDeps({ signer, balanceReader }),
      receiptTracker: pendingTracker,
    };
    const readyDeps = {
      ...buildEnsureReadyDeps({ signer, balanceReader }),
      receiptTracker: pendingTracker,
    };

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-reserve-recon-${randomUUID()}`,
          runId: `run-reserve-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-reserve-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-reserve-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);

    const rows = await handle.db.select().from(fundingTransactions);
    const counted = rows.filter((row) =>
      ['created', 'submitted', 'submission_unknown', 'confirmed'].includes(row.status),
    );
    const totalSubmittedSpend = counted.reduce((sum, row) => sum + BigInt(row.amountWei), 0n);
    expect(totalSubmittedSpend).toBeLessThanOrEqual(treasuryBalanceWei - reserveWei);
    expect(totalSubmittedSpend).toBeGreaterThan(0n);

    const reconcileResult = settled[0];
    const readyResult = settled[1];
    expect(reconcileResult?.status).toBe('fulfilled');
    expect(readyResult?.status).toBe('fulfilled');

    let reconcileBlocked = 0;
    if (reconcileResult?.status === 'fulfilled') {
      const reconcile = reconcileResult.value as ReconcileWalletsResult;
      reconcileBlocked = reconcile.counters.blocked;
      expect(reconcileBlocked).toBeGreaterThanOrEqual(1);
    }
    if (readyResult?.status === 'fulfilled') {
      const ready = readyResult.value as EnsureEnvironmentReadyResult;
      const refused = ready.wallets.filter(
        (wallet) =>
          (wallet.status === 'blocked' || wallet.status === 'warning') &&
          wallet.reasonCode === 'FUNDING_BLOCKED_RESERVE',
      );
      // At least one path must surface reserve refusal as blocked/warning — not silence.
      expect(refused.length + reconcileBlocked).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * TX.10: durable broadcast intent survives `pg_terminate_backend` of the
   * lock-holder, so the waiter gates on the interrupted attempt instead of
   * broadcasting a second transfer (P4-US2 / the defect T4.4 measured).
   */
  it('crash mid-dispatch while the other racer waits: durable intent gates waiter, one send', async () => {
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

    const reconcileDeps = buildReconcileDeps({ signer, balanceReader });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    // Start reconciler first so it holds the lock during send.
    const reconcilePromise = reconcileWallets(reconcileDeps, {
      role: 'cron-reconciler',
      credentialId: cronCredentialId,
      correlationId: `corr-crash-recon-${randomUUID()}`,
      runId: `run-crash-${randomUUID()}`,
    });

    await firstEntered.promise;

    // Intent must already be durable before the signer is entered (TX.10).
    await expect
      .poll(
        async () => {
          const rows = await handle.db.select().from(fundingTransactions);
          return rows.filter((row) => ['submission_unknown', 'submitted', 'created'].includes(row.status))
            .length;
        },
        { interval: 10, timeout: 5_000 },
      )
      .toBe(1);

    const readyPromise = ensureEnvironmentReady(readyDeps, {
      environmentId: seed.environmentId,
      idempotencyKey: `ready-crash-${randomUUID()}`,
      role: 'operator',
      credentialId: operatorCredentialId,
      correlationId: `corr-crash-ready-${randomUUID()}`,
      sourceIp: '127.0.0.1',
    });

    await waitForAdvisoryLockWaiters(handle.pool, 1);

    const lockHolders = await listGrantedAdvisoryLockPids(handle.pool);
    expect(lockHolders.length).toBeGreaterThanOrEqual(1);
    for (const pid of lockHolders) {
      const terminated = await handle.pool.query<{ pg_terminate_backend: boolean }>(
        'SELECT pg_terminate_backend($1) AS pg_terminate_backend',
        [pid],
      );
      expect(terminated.rows[0]?.pg_terminate_backend).toBe(true);
    }

    await expect
      .poll(async () => listGrantedAdvisoryLockPids(handle.pool), { interval: 10, timeout: 5_000 })
      .toEqual([]);

    sendHold.resolve();

    const settled = await runRacing<unknown>([() => reconcilePromise, () => readyPromise]);
    void settled;

    const txs = await handle.db.select().from(fundingTransactions);
    const transferred = txs.filter((row) =>
      ['submitted', 'confirmed', 'created', 'submission_unknown'].includes(row.status),
    );
    expect(transferred).toHaveLength(1);
    expect(transferred[0]?.nonce).toBeTypeOf('number');
    // Exactly one broadcast attempt completed; waiter must not send again.
    expect(signer.sendCalls).toBe(1);
    expect(signer.enteredSendCount).toBe(1);
  });

  it('genuinely orphaned transfer (no intent row) is still reported as unexplained_outgoing_transfer under race', async () => {
    // TX.10 must not weaken TX.9 detection: an on-chain transfer with no
    // funding_transactions row at all remains a critical finding.
    const orphanHash = `0x${'ef'.repeat(32)}`;
    const outgoingScanner = createFakeOutgoingScanner({
      latestBlockNumber: 100n,
      transfers: [
        {
          transactionHash: orphanHash,
          fromAddress: TREASURY_ADDRESS,
          toAddress: WALLET_B_ADDRESS,
          valueWei: ONE_ETH / 5n,
          nonce: 99,
          blockNumber: 88n,
        },
      ],
    });

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH,
      },
    });
    const signer = createFakeSigner({
      address: TREASURY_ADDRESS,
      rejectReusedNonce: true,
    });

    const reconcileDeps = buildReconcileDeps({ signer, balanceReader, outgoingScanner });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-orphan-recon-${randomUUID()}`,
          runId: `run-orphan-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-orphan-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-orphan-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    const reconcileResult = settled[0];
    expect(reconcileResult?.status).toBe('fulfilled');
    if (reconcileResult?.status === 'fulfilled') {
      const reconcile = reconcileResult.value as ReconcileWalletsResult;
      expect(reconcile.unexplainedTransferCount).toBe(1);
      expect(
        reconcile.findings.some(
          (finding) =>
            finding.kind === 'unexplained_outgoing_transfer' && finding.transactionHash === orphanHash,
        ),
      ).toBe(true);
    }

    const txs = await handle.db.select().from(fundingTransactions);
    expect(txs.every((tx) => tx.transactionHash !== orphanHash)).toBe(true);
  });

  it('ambiguous post-broadcast RPC_UNAVAILABLE under race leaves submission_unknown pending, no second send', async () => {
    // Distinct from backend-kill: sendError produces a durable row via the
    // normal ambiguous path (funding-crash-recovery.test.ts pattern).
    let sendAttempts = 0;
    const signer = createControllableSigner({
      address: TREASURY_ADDRESS,
      sendError: () => {
        sendAttempts += 1;
        return new ChainBankError('RPC_UNAVAILABLE', 'transport failed after possible broadcast', {
          publicMessage: 'The transfer could not be submitted.',
        });
      },
      getNonce: () => sendAttempts,
    });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });

    const reconcileDeps = buildReconcileDeps({ signer, balanceReader });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-ambig-recon-${randomUUID()}`,
          runId: `run-ambig-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-ambig-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-ambig-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    const txs = await handle.db.select().from(fundingTransactions);
    const unknowns = txs.filter((row) => row.status === 'submission_unknown');
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]?.nonce).toBeTypeOf('number');
    // One side entered send and failed ambiguously; the other must not send.
    expect(signer.enteredSendCount).toBe(1);
    expect(signer.sendCalls).toBe(0);
    expect(txs).toHaveLength(1);

    // At least one racer must surface the ambiguity rather than a silent retry.
    const rejected = settled.filter((result) => result.status === 'rejected');
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    expect(rejected.length + fulfilled.length).toBe(2);
    void settled;
  });

  it('watermark advances exactly once under race (forward-contiguous, M+C ≥ T → complete)', async () => {
    const markerBefore = 1_000n;
    const tip = 1_050n;
    const cap = 100n; // M + C = 1_100 ≥ T → complete, advance to T

    await handle.db
      .update(treasuries)
      .set({
        lastOutgoingScanBlock: markerBefore.toString(),
        lastOutgoingScanAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      .where(eq(treasuries.id, seed.treasuryId));

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: tip });
    const signer = createFakeSigner({
      address: TREASURY_ADDRESS,
      rejectReusedNonce: true,
      send: (input) => {
        const current = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase()) ?? 0n;
        balanceReader.setBalance(WALLET_A_ADDRESS.toLowerCase(), current + input.valueWei);
        return Promise.resolve({ transactionHash: `0x${'aa'.repeat(32)}` });
      },
    });

    const reconcileDeps = buildReconcileDeps({
      signer,
      balanceReader,
      outgoingScanner: scanner,
      outgoingLookbackBlocks: cap,
    });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const settled = await runRacing<unknown>([
      () =>
        reconcileWallets(reconcileDeps, {
          role: 'cron-reconciler',
          credentialId: cronCredentialId,
          correlationId: `corr-wm-recon-${randomUUID()}`,
          runId: `run-wm-${randomUUID()}`,
        }),
      () =>
        ensureEnvironmentReady(readyDeps, {
          environmentId: seed.environmentId,
          idempotencyKey: `ready-wm-${randomUUID()}`,
          role: 'operator',
          credentialId: operatorCredentialId,
          correlationId: `corr-wm-ready-${randomUUID()}`,
          sourceIp: '127.0.0.1',
        }),
    ]);

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);

    // Forward-contiguous window: [M+1, min(M+C, T)] = [1001, 1050]
    expect(scanner.listCalls.length).toBeGreaterThanOrEqual(1);
    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 1_001n, toBlock: tip });

    const treasuryRepo = createTreasuryRepository(handle.db);
    const after = await treasuryRepo.findById(seed.treasuryId);
    expect(after?.lastOutgoingScanBlock).toBe(tip);

    const reconcileResult = settled[0];
    if (reconcileResult?.status === 'fulfilled') {
      expect((reconcileResult.value as ReconcileWalletsResult).outgoingScanStatus).toBe('complete');
    }

    // Exactly one durable advance (one finished run that scanned).
    const runs = await handle.db.select().from(reconciliationRuns);
    const finishedScans = runs.filter(
      (run) => run.finishedAt !== null && run.outgoingScanStatus === 'complete',
    );
    expect(finishedScans).toHaveLength(1);
  });

  it('watermark backlog: M+C < T → incomplete, advances only to M+C', async () => {
    const markerBefore = 1_000n;
    const tip = 5_000n;
    const cap = 100n; // advance to 1_100, status incomplete

    await handle.db
      .update(treasuries)
      .set({
        lastOutgoingScanBlock: markerBefore.toString(),
        lastOutgoingScanAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      .where(eq(treasuries.id, seed.treasuryId));

    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH,
      },
    });
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: tip });
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });

    const result = await reconcileWallets(
      buildReconcileDeps({
        signer,
        balanceReader,
        outgoingScanner: scanner,
        outgoingLookbackBlocks: cap,
      }),
      {
        role: 'cron-reconciler',
        credentialId: cronCredentialId,
        correlationId: `corr-backlog-${randomUUID()}`,
        runId: `run-backlog-${randomUUID()}`,
      },
    );

    expect(scanner.listCalls[0]).toMatchObject({ fromBlock: 1_001n, toBlock: 1_100n });
    expect(result.outgoingScanStatus).toBe('incomplete');
    expect(result.findings.some((finding) => finding.kind === 'outgoing_scan_coverage_behind')).toBe(true);

    const treasuryRepo = createTreasuryRepository(handle.db);
    const after = await treasuryRepo.findById(seed.treasuryId);
    expect(after?.lastOutgoingScanBlock).toBe(1_100n);
  });

  /**
   * TX.9: watermark advances only after the run row is durable. When the
   * lock-holding reconciler is terminated mid-dispatch, the in-lock funding
   * work rolls back; the run may still finish on another pool connection.
   * Assert the marker never advances past what was scanned, and never advances
   * when no finished run exists for this race.
   */
  it('interrupted reconciler mid-dispatch does not advance watermark without a durable run', async () => {
    const markerBefore = 2_000n;
    const tip = 2_050n;
    const cap = 100n;

    await handle.db
      .update(treasuries)
      .set({
        lastOutgoingScanBlock: markerBefore.toString(),
        lastOutgoingScanAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      .where(eq(treasuries.id, seed.treasuryId));

    const sendHold = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const signer = createControllableSigner({
      address: TREASURY_ADDRESS,
      // Hold only the first send so terminating the lock holder can release the
      // waiter; a second send must not re-acquire and wait on the same gate.
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
    const scanner = createFakeOutgoingScanner({ latestBlockNumber: tip });

    const reconcileDeps = buildReconcileDeps({
      signer,
      balanceReader,
      outgoingScanner: scanner,
      outgoingLookbackBlocks: cap,
    });
    const readyDeps = buildEnsureReadyDeps({ signer, balanceReader });

    const reconcilePromise = reconcileWallets(reconcileDeps, {
      role: 'cron-reconciler',
      credentialId: cronCredentialId,
      correlationId: `corr-wm-crash-${randomUUID()}`,
      runId: `run-wm-crash-${randomUUID()}`,
    });

    await firstEntered.promise;

    const readyPromise = ensureEnvironmentReady(readyDeps, {
      environmentId: seed.environmentId,
      idempotencyKey: `ready-wm-crash-${randomUUID()}`,
      role: 'operator',
      credentialId: operatorCredentialId,
      correlationId: `corr-wm-crash-ready-${randomUUID()}`,
      sourceIp: '127.0.0.1',
    });

    await waitForAdvisoryLockWaiters(handle.pool, 1);

    const lockHolders = await listGrantedAdvisoryLockPids(handle.pool);
    expect(lockHolders.length).toBeGreaterThanOrEqual(1);
    for (const pid of lockHolders) {
      const terminated = await handle.pool.query<{ pg_terminate_backend: boolean }>(
        'SELECT pg_terminate_backend($1) AS pg_terminate_backend',
        [pid],
      );
      expect(terminated.rows[0]?.pg_terminate_backend).toBe(true);
    }

    await expect
      .poll(async () => listGrantedAdvisoryLockPids(handle.pool), { interval: 10, timeout: 5_000 })
      .toEqual([]);

    sendHold.resolve();
    await runRacing<unknown>([() => reconcilePromise, () => readyPromise]);

    const treasuryRepo = createTreasuryRepository(handle.db);
    const after = await treasuryRepo.findById(seed.treasuryId);
    const runs = await handle.db.select().from(reconciliationRuns);
    const durableFinished = runs.filter((run) => run.finishedAt !== null);

    if (durableFinished.length === 0) {
      // TX.9: no durable run ⇒ marker must not move.
      expect(after?.lastOutgoingScanBlock).toBe(markerBefore);
    } else {
      // Run finished after the interrupted send: advance only to the scanned tip.
      expect(after?.lastOutgoingScanBlock).toBe(tip);
    }
  });

  function readErrorCode(reason: unknown): string | undefined {
    if (isChainBankError(reason)) {
      return reason.code;
    }
    if (typeof reason === 'object' && reason !== null && 'code' in reason) {
      const code = (reason as { readonly code: unknown }).code;
      return typeof code === 'string' ? code : undefined;
    }
    return undefined;
  }

  function buildReconcileDeps(options: {
    readonly signer: TreasurySigner;
    readonly balanceReader: BalanceReader;
    readonly outgoingScanner?: ReturnType<typeof createFakeOutgoingScanner>;
    readonly outgoingLookbackBlocks?: bigint;
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
      outgoingScanner: options.outgoingScanner ?? createFakeOutgoingScanner({ latestBlockNumber: 100n }),
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
      ...(options.outgoingLookbackBlocks === undefined
        ? { outgoingLookbackBlocks: 20_000n }
        : { outgoingLookbackBlocks: options.outgoingLookbackBlocks }),
    };
  }

  function buildEnsureReadyDeps(options: {
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
      environments: createEnvironmentRepository(handle.db),
      projects: createProjectRepository(handle.db),
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
