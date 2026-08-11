import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generatePrivateKey } from 'viem/accounts';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import { ensureWalletFunded } from '../../src/app/funding/ensure-wallet-funded.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
import { ChainBankError } from '../../src/domain/errors.js';
import type { FundingTransactionStatus } from '../../src/domain/funding/statuses.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentials,
  fundingPolicies,
  fundingTransactions,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import {
  createControllableSigner,
  createDeferred,
  createFakeBalanceReader,
  createFakeReceiptTracker,
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

describe.skipIf(!integrationEnabled)('ensure-funded concurrency (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let credentialId: string;
  let operatorToken: string;

  beforeAll(async () => {
    // Concurrent advisory-lock holders each occupy a pool connection.
    handle = createIntegrationDatabase({ poolMax: 12 });
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    await handle.db.insert(fundingPolicies).values({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: ONE_ETH.toString(),
      targetBalanceWei: (2n * ONE_ETH).toString(),
      maximumTopUpWei: (5n * ONE_ETH).toString(),
      version: 1,
    });

    const generated = generateApiToken();
    operatorToken = generated.token;
    const [credential] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (credential === undefined) {
      throw new Error('failed to seed operator credential');
    }
    credentialId = credential.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function createBalanceReader(
    options: {
      readonly treasuryBalanceWei?: bigint;
      readonly walletBalances?: ReadonlyMap<string, bigint>;
    } = {},
  ): BalanceReader {
    const treasuryBalanceWei = options.treasuryBalanceWei ?? 20n * ONE_ETH;
    const walletBalances =
      options.walletBalances ?? new Map([[WALLET_A_ADDRESS.toLowerCase(), ONE_ETH / 10n]]);
    return {
      readBalance(address) {
        const normalized = address.toLowerCase();
        const balanceWei =
          normalized === TREASURY_ADDRESS.toLowerCase()
            ? treasuryBalanceWei
            : (walletBalances.get(normalized) ?? ONE_ETH / 10n);
        return Promise.resolve({
          kind: 'observed',
          balanceWei,
          blockNumber: 42n,
          observedAt: new Date('2026-07-29T12:00:00.000Z'),
        });
      },
      verifyChainId() {
        return Promise.resolve({ matches: true, observedChainId: 11_155_111 });
      },
    };
  }

  function buildEnsureDeps(
    signer: TreasurySigner,
    options: {
      readonly balanceReader?: BalanceReader;
      /** Keep rows `submitted` so later concurrent reserve checks still see them. */
      readonly leaveSubmittedPending?: boolean;
    } = {},
  ) {
    const clock = createFixedClock();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    return {
      managedWallets: createManagedWalletRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
      balanceObservations: createBalanceObservationRepository(handle.db),
      balanceReader: options.balanceReader ?? createBalanceReader(),
      credentialScopes: createCredentialScopeRepository(handle.db),
      auditEvents: createAuditEventRepository(handle.db),
      alerts: createAlertRepository(handle.db),
      emailSender: undefined,
      operations: createFundingOperationRepository(handle.db),
      transactions: createFundingTransactionRepository(handle.db),
      lock: createFundingDispatchLock(handle.db),
      receiptTracker: createFakeReceiptTracker(
        options.leaveSubmittedPending === true
          ? { kind: 'pending' }
          : {
              kind: 'confirmed',
              confirmedAt: new Date('2026-07-29T12:00:01.000Z'),
            },
      ),
      signer,
      clock,
      idGenerator: { next: () => randomUUID() },
      logger,
      isFundingEnabled: true,
      isFundingKillSwitchActive: false,
      confirmations: 1,
      confirmationTimeoutMs: 5_000,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
    };
  }

  async function buildRouteApp(signer: TreasurySigner): Promise<AppInstance> {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: generatePrivateKey(),
        TREASURY_ADDRESS,
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    });
    const clock = createFixedClock();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const container: Container = {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database: {
        db: handle.db,
        pool: handle.pool,
        close: () => Promise.resolve(),
      },
      repositories: {
        chains: createChainRepository(handle.db),
        treasuries: createTreasuryRepository(handle.db),
        balanceObservations: createBalanceObservationRepository(handle.db),
        apiCredentials: createApiCredentialRepository(handle.db),
        auditEvents: createAuditEventRepository(handle.db),
        serviceHeartbeats: createServiceHeartbeatRepository(handle.db),
        managedWallets: createManagedWalletRepository(handle.db),
        fundingPolicies: createFundingPolicyRepository(handle.db),
        projects: createProjectRepository(handle.db),
        environments: createEnvironmentRepository(handle.db),
        credentialScopes: createCredentialScopeRepository(handle.db),
        fundingOperations: createFundingOperationRepository(handle.db),
        fundingTransactions: createFundingTransactionRepository(handle.db),
        alerts: createAlertRepository(handle.db),
        reconciliationRuns: {} as Container['repositories']['reconciliationRuns'],
        reconciliationFunding: {} as Container['repositories']['reconciliationFunding'],
        fundingHealth: {} as Container['repositories']['fundingHealth'],
      },
      balanceReader: createBalanceReader(),
      treasurySigner: signer,
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      operatorMutations: createOperatorMutationTransaction(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: new Date('2026-07-29T12:00:01.000Z'),
      }),
      treasuryOutgoingScanner: {} as Container['treasuryOutgoingScanner'],
      emailSender: undefined,
      close: () => Promise.resolve(),
    };
    return buildApp(container);
  }

  it('parallel ensureWalletFunded with distinct keys submits exactly once', async () => {
    const sendHold = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const signer = createControllableSigner({
      onSend: async () => {
        if (signer.enteredSendCount === 1) {
          firstEntered.resolve();
          await sendHold.promise;
        }
      },
      getNonce: () => signer.sendCalls,
    });

    // Leave the winner `submitted` so late lock-holders still see the C4 in-flight gate
    // (instant fake confirmation would otherwise clear the gate before waiters run).
    const deps = buildEnsureDeps(signer, { leaveSubmittedPending: true });
    const keys = ['par-a', 'par-b', 'par-c', 'par-d'] as const;
    const promises = keys.map((idempotencyKey, index) =>
      ensureWalletFunded(deps, {
        walletId: seed.managedWalletId,
        idempotencyKey,
        role: 'operator',
        credentialId,
        correlationId: `corr-par-${String(index)}`,
        sourceIp: '127.0.0.1',
      }),
    );

    await firstEntered.promise;
    // Ensure the other three are queued on pg_advisory_xact_lock before release.
    await waitForAdvisoryLockWaiters(handle.pool, keys.length - 1);
    sendHold.resolve();

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    if (fulfilled[0]?.status === 'fulfilled') {
      expect(fulfilled[0].value.status).toBe('pending');
    }
    for (const result of rejected) {
      if (result.status !== 'rejected') {
        continue;
      }
      expect(result.reason).toBeInstanceOf(ChainBankError);
      expect((result.reason as ChainBankError).code).toBe('PENDING_FUNDING_EXISTS');
    }

    const rows = await handle.db.select().from(fundingTransactions);
    const submitted = rows.filter((row) => row.status === 'submitted');
    expect(submitted).toHaveLength(1);
    expect(signer.sendCalls).toBe(1);
  });

  it('parallel distinct keys with instant confirmation: in-lock re-read yields one transfer', async () => {
    // TX.8: when the winner confirms before the loser enters the advisory lock,
    // the C4 pending-tx gate is clear. Without an in-lock wallet re-read the
    // loser would sign from its stale pre-lock balance. The loser's lock-time
    // read must see the funded wallet and no-op.
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS.toLowerCase()]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS.toLowerCase()]: ONE_ETH / 10n,
      },
    });

    const signer = createControllableSigner({
      onSend: (input) => {
        const current = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase()) ?? 0n;
        balanceReader.setBalance(WALLET_A_ADDRESS.toLowerCase(), current + input.valueWei);
        return Promise.resolve();
      },
      getNonce: () => signer.sendCalls,
    });

    // Instant-confirm tracker (default): confirmation clears the in-flight gate.
    const deps = buildEnsureDeps(signer, { balanceReader });

    const releaseLoser = createDeferred<void>();
    const winnerPromise = ensureWalletFunded(deps, {
      walletId: seed.managedWalletId,
      idempotencyKey: 'inst-winner',
      role: 'operator',
      credentialId,
      correlationId: 'corr-inst-winner',
      sourceIp: '127.0.0.1',
    });

    const loserPromise = (async () => {
      await releaseLoser.promise;
      // Force a stale pre-lock observation below minimum while the in-lock
      // BalanceReader still sees the post-confirm funded balance.
      const fundedWei = balanceReader.balances.get(WALLET_A_ADDRESS.toLowerCase()) ?? 0n;
      expect(fundedWei).toBeGreaterThanOrEqual(ONE_ETH);

      let walletReadsForLoser = 0;
      const loserReader: BalanceReader = {
        verifyChainId: () => balanceReader.verifyChainId(),
        readBalance: async (address) => {
          if (address.toLowerCase() === WALLET_A_ADDRESS.toLowerCase()) {
            walletReadsForLoser += 1;
            if (walletReadsForLoser === 1) {
              return {
                kind: 'observed',
                balanceWei: ONE_ETH / 10n,
                blockNumber: 42n,
                observedAt: new Date('2026-07-29T12:00:00.000Z'),
              };
            }
          }
          return balanceReader.readBalance(address);
        },
      };

      return ensureWalletFunded(
        { ...deps, balanceReader: loserReader },
        {
          walletId: seed.managedWalletId,
          idempotencyKey: 'inst-loser',
          role: 'operator',
          credentialId,
          correlationId: 'corr-inst-loser',
          sourceIp: '127.0.0.1',
        },
      );
    })();

    const winner = await winnerPromise;
    expect(winner.status).toBe('funded');
    expect(signer.sendCalls).toBe(1);
    releaseLoser.resolve();

    const loser = await loserPromise;
    expect(loser.status).toBe('no-op');
    expect(signer.sendCalls).toBe(1);

    const rows = await handle.db.select().from(fundingTransactions);
    const transferred = rows.filter((row) =>
      ['submitted', 'confirmed', 'created', 'submission_unknown'].includes(row.status),
    );
    expect(transferred).toHaveLength(1);
    expect(transferred[0]?.status).toBe('confirmed');
  });

  it('route idempotency: same key+wallet replays; same key+different wallet does not cross-replay', async () => {
    const signer = createControllableSigner({});
    const app = await buildRouteApp(signer);

    try {
      const walletB = await seedManagedWallet(handle.db, {
        environmentId: seed.environmentId,
        chainId: seed.chainId,
        address: '0x3333333333333333333333333333333333333333',
        policy: {
          minimumBalanceWei: ONE_ETH.toString(),
          targetBalanceWei: (2n * ONE_ETH).toString(),
          maximumTopUpWei: (5n * ONE_ETH).toString(),
        },
      });

      const sharedKey = 'route-idem-shared';
      const pathA = `/v1/wallets/${seed.managedWalletId}/ensure-funded`;
      const pathB = `/v1/wallets/${walletB.id}/ensure-funded`;

      const first = await app.inject({
        method: 'POST',
        url: pathA,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { idempotencyKey: sharedKey },
      });
      expect(first.statusCode).toBe(200);
      const firstJson = first.json<{ data: { operationId: string; status: string } }>();
      expect(firstJson.data.status).toBe('funded');
      expect(signer.sendCalls).toBe(1);

      const replay = await app.inject({
        method: 'POST',
        url: pathA,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { idempotencyKey: sharedKey },
      });
      expect(replay.statusCode).toBe(200);
      const replayJson = replay.json<{ data: { operationId: string } }>();
      expect(replayJson.data.operationId).toBe(firstJson.data.operationId);
      expect(signer.sendCalls).toBe(1);

      const otherWallet = await app.inject({
        method: 'POST',
        url: pathB,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { idempotencyKey: sharedKey },
      });
      expect(otherWallet.statusCode).toBe(200);
      const otherJson = otherWallet.json<{ data: { operationId: string; status: string } }>();
      expect(otherJson.data.status).toBe('funded');
      expect(otherJson.data.operationId).not.toBe(firstJson.data.operationId);
      expect(signer.sendCalls).toBe(2);

      const rows = await handle.db.select().from(fundingTransactions);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.managedWalletId))).toEqual(
        new Set([seed.managedWalletId, walletB.id]),
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    ['created', 'created' as const],
    ['submitted', 'submitted' as const],
    ['submission_unknown', 'submission_unknown' as const],
  ] as const)(
    'pending-tx gate refuses ensure-funded when an in-flight row is %s',
    async (
      _label,
      status: Extract<FundingTransactionStatus, 'created' | 'submitted' | 'submission_unknown'>,
    ) => {
      await seedInFlightFundingTransaction(handle.db, {
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        treasuryId: seed.treasuryId,
        managedWalletId: seed.managedWalletId,
        amountWei: ONE_ETH.toString(),
        status,
      });

      const signer = createControllableSigner({});
      const deps = buildEnsureDeps(signer);

      await expect(
        ensureWalletFunded(deps, {
          walletId: seed.managedWalletId,
          idempotencyKey: `pending-gate-${status}`,
          role: 'operator',
          credentialId,
          correlationId: `corr-pending-${status}`,
          sourceIp: undefined,
        }),
      ).rejects.toMatchObject({ code: 'PENDING_FUNDING_EXISTS' });

      expect(signer.sendCalls).toBe(0);
      expect(signer.enteredSendCount).toBe(0);
    },
  );

  it('parallel ensure-funded across wallets keeps submitted spend within balance − reserve', async () => {
    // Same shape as the unit reserve accounting test: 10 ETH balance, 9 ETH reserve,
    // 0.9 ETH max top-up → spendable ~1 ETH; excess requests return FUNDING_BLOCKED_RESERVE.
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
      address: '0x3333333333333333333333333333333333333333',
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: maxTopUpWei.toString(),
      },
    });
    const walletC = await seedManagedWallet(handle.db, {
      environmentId: seed.environmentId,
      chainId: seed.chainId,
      address: '0x4444444444444444444444444444444444444444',
      policy: {
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: maxTopUpWei.toString(),
      },
    });

    const walletBalances = new Map<string, bigint>([
      [WALLET_A_ADDRESS.toLowerCase(), 0n],
      [walletB.address.toLowerCase(), 0n],
      [walletC.address.toLowerCase(), 0n],
    ]);

    const sendHold = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const signer = createControllableSigner({
      onSend: async () => {
        if (signer.enteredSendCount === 1) {
          firstEntered.resolve();
          await sendHold.promise;
        }
      },
      getNonce: () => signer.sendCalls,
      estimatedCostWei: 21_000n,
    });

    const deps = buildEnsureDeps(signer, {
      balanceReader: createBalanceReader({ treasuryBalanceWei, walletBalances }),
      // Confirmation would clear in-flight status before the next lock holder runs.
      leaveSubmittedPending: true,
    });
    const walletIds = [seed.managedWalletId, walletB.id, walletC.id] as const;

    const promises = walletIds.map((walletId, index) =>
      ensureWalletFunded(deps, {
        walletId,
        idempotencyKey: `reserve-${String(index)}`,
        role: 'operator',
        credentialId,
        correlationId: `corr-reserve-${String(index)}`,
        sourceIp: undefined,
      }),
    );

    await firstEntered.promise;
    await waitForAdvisoryLockWaiters(handle.pool, walletIds.length - 1);
    sendHold.resolve();

    const settled = await Promise.all(promises);

    const fundedOrPending = settled.filter((r) => r.status === 'funded' || r.status === 'pending');
    const blocked = settled.filter(
      (r) => r.status === 'blocked' && r.reasonCode === 'FUNDING_BLOCKED_RESERVE',
    );

    expect(fundedOrPending.length + blocked.length).toBe(3);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(signer.sendCalls).toBe(fundedOrPending.length);

    const rows = await handle.db.select().from(fundingTransactions);
    const counted = rows.filter((row) =>
      ['created', 'submitted', 'submission_unknown', 'confirmed'].includes(row.status),
    );
    const totalSubmittedSpend = counted.reduce((sum, row) => sum + BigInt(row.amountWei), 0n);
    expect(totalSubmittedSpend).toBeLessThanOrEqual(treasuryBalanceWei - reserveWei);
  });
});
