import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generatePrivateKey } from 'viem/accounts';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import { createDatabase } from '../../src/infrastructure/db/client.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingHealthQuery } from '../../src/infrastructure/db/repositories/funding-health-query-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createReconciliationFundingQuery } from '../../src/infrastructure/db/repositories/reconciliation-query-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  fundingPolicies,
  managedWallets,
  reconciliationRuns,
  serviceHeartbeats,
} from '../../src/infrastructure/db/schema.js';
import {
  HEARTBEAT_SERVICE_ROLE,
  buildReconcileWalletsDependencies,
  logAbortedReconciliationRuns,
  runWalletReconciler,
} from '../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../src/observability/logger.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import {
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
} from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const ONE_ETH = 10n ** 18n;
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
const WALLET_A_ADDRESS = '0x2222222222222222222222222222222222222222';

describe.skipIf(!integrationEnabled)('wallet-reconciler job entry (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;

  beforeAll(async () => {
    handle = createIntegrationDatabase({ poolMax: 6 });
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    await handle.pool.query('TRUNCATE TABLE service_heartbeats RESTART IDENTITY CASCADE');
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
  });

  afterAll(async () => {
    await handle.close();
  });

  it('runs the sweep, writes run + heartbeat, and closes the pool', async () => {
    // Dedicated pool so ending it does not break the suite-shared handle.
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL required');
    }
    const logger = createLogger({ level: 'silent', serviceRole: 'cron-reconciler', environment: 'test' });
    const dedicated = createDatabase(
      { url: databaseUrl, useSsl: false, poolMax: 2, sslCertificateAuthority: undefined },
      logger,
    );
    const container = buildJobContainer({
      fundingEnabled: true,
      database: dedicated,
      close: () => dedicated.close(),
    });
    const signer = createFakeSigner({ address: TREASURY_ADDRESS });
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS]: 20n * ONE_ETH,
        [WALLET_A_ADDRESS]: ONE_ETH / 10n,
      },
    });

    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: buildReconcileWalletsDependencies(container, {
        signer,
        balanceReader,
        outgoingScanner: createFakeOutgoingScanner(),
        receiptTracker: createFakeReceiptTracker({
          kind: 'confirmed',
          confirmedAt: container.clock.now(),
        }),
        isFundingEnabled: true,
        isFundingKillSwitchActive: false,
      }),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.exitKind).toBe('success');
    expect(outcome.reconcileResult?.counters.funded).toBe(1);
    expect(signer.sendCalls).toBe(1);

    const runs = await handle.db.select().from(reconciliationRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBeTruthy();
    expect(runs[0]?.errorCode).toBeNull();
    expect(runs[0]?.walletsFunded).toBe(1);

    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    expect(heartbeats.some((row) => row.serviceRole === HEARTBEAT_SERVICE_ROLE)).toBe(true);

    await container.close();
    await expect(dedicated.pool.query('select 1')).rejects.toThrow();
    // Suite handle remains usable.
    await expect(handle.pool.query('select 1')).resolves.toBeTruthy();
  });

  it('exits zero when funding is disabled (policy, not malfunction)', async () => {
    const container = buildJobContainer({ fundingEnabled: false });

    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: buildReconcileWalletsDependencies(container, {
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader: createFakeBalanceReader({
          balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
        }),
        isFundingEnabled: false,
        isFundingKillSwitchActive: false,
      }),
    });

    expect(outcome.exitKind).toBe('policy-disabled');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reconcileResult?.run.errorCode).toBe('FUNDING_DISABLED');

    const runs = await handle.db.select().from(reconciliationRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBeTruthy();
    expect(runs[0]?.errorCode).toBe('FUNDING_DISABLED');
  });

  it('exits non-zero on a forced run-level error and still records the run', async () => {
    const container = buildJobContainer({ fundingEnabled: true });
    const base = buildReconcileWalletsDependencies(container, {
      signer: createFakeSigner({ address: TREASURY_ADDRESS }),
      balanceReader: createFakeBalanceReader({
        balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
      }),
      isFundingEnabled: true,
    });

    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: {
        ...base,
        treasuries: {
          ...base.treasuries,
          listEnabled: () => Promise.reject(new Error('forced RPC/DB failure')),
        },
      },
    });

    expect(outcome.exitKind).toBe('malfunction');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reconcileResult?.run.errorCode).toBe('INTERNAL_ERROR');
    expect(outcome.reconcileResult?.run.finishedAt).toBeTruthy();

    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    expect(heartbeats.some((row) => row.serviceRole === HEARTBEAT_SERVICE_ROLE)).toBe(true);
  });

  it('logs prior aborted reconciliation runs (finished_at IS NULL)', async () => {
    const container = buildJobContainer({ fundingEnabled: false });
    await handle.db.insert(reconciliationRuns).values({
      id: randomUUID(),
      runId: `aborted-${randomUUID()}`,
      requestedBy: 'wallet-reconciler',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      finishedAt: null,
      // finished_at IS NULL is authoritative — never treat an aborted row as clean.
    });

    const abortedCount = await logAbortedReconciliationRuns(container, `corr-${randomUUID()}`);
    expect(abortedCount).toBe(1);
  });

  function buildJobContainer(options: {
    readonly fundingEnabled: boolean;
    readonly database?: Container['database'];
    readonly close?: () => Promise<void>;
  }): Container {
    const privateKey = generatePrivateKey();
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv({
        DATABASE_URL: process.env.DATABASE_URL,
        TREASURY_ADDRESS,
        FUNDING_ENABLED: options.fundingEnabled ? 'true' : 'false',
        TREASURY_PRIVATE_KEY: privateKey,
        EMAIL_PROVIDER: 'log-only',
      }),
    });
    const logger = createLogger({ level: 'silent', serviceRole: 'cron-reconciler', environment: 'test' });
    const clock = createFixedClock();
    const database =
      options.database ??
      ({
        db: handle.db,
        pool: handle.pool,
        close: async () => {
          // Suite-shared pool — closed in afterAll only.
        },
      } satisfies Container['database']);

    return {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database,
      repositories: {
        chains: createChainRepository(database.db),
        treasuries: createTreasuryRepository(database.db),
        balanceObservations: createBalanceObservationRepository(database.db),
        apiCredentials: createApiCredentialRepository(database.db),
        auditEvents: createAuditEventRepository(database.db),
        serviceHeartbeats: createServiceHeartbeatRepository(database.db),
        managedWallets: createManagedWalletRepository(database.db),
        fundingPolicies: createFundingPolicyRepository(database.db),
        projects: createProjectRepository(database.db),
        environments: createEnvironmentRepository(database.db),
        credentialScopes: createCredentialScopeRepository(database.db),
        fundingOperations: createFundingOperationRepository(database.db),
        fundingTransactions: createFundingTransactionRepository(database.db),
        alerts: createAlertRepository(database.db),
        reconciliationRuns: createReconciliationRunRepository(database.db),
        reconciliationFunding: createReconciliationFundingQuery(database.db),
        fundingHealth: createFundingHealthQuery(database.db),
      },
      balanceReader: createFakeBalanceReader({
        balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
      }),
      treasurySigner: createFakeSigner({ address: TREASURY_ADDRESS }),
      fundingDispatchLock: createFundingDispatchLock(database.db),
      operatorMutations: createOperatorMutationTransaction(database.db),
      transactionReceiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: clock.now(),
      }),
      treasuryOutgoingScanner: createFakeOutgoingScanner(),
      emailSender: {
        send() {
          return Promise.resolve({ kind: 'sent' as const, providerMessageId: `msg-${randomUUID()}` });
        },
      },
      close: options.close ?? (async () => {}),
    };
  }
});
