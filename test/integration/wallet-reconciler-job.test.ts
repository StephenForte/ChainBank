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
  createTestChainAdapterRegistry,
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

function abortedRunWarnings(chunks: readonly string[]): Array<{
  readonly markedAborted?: boolean;
  readonly abortedRuns?: unknown;
}> {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.includes('Prior reconciliation runs aborted before finish'))
    .map((line) => JSON.parse(line) as { markedAborted?: boolean; abortedRuns?: unknown });
}
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
        chainAdapters: createTestChainAdapterRegistry({
          signer,
          balanceReader,
          outgoingScanner: createFakeOutgoingScanner(),
          receiptTracker: createFakeReceiptTracker({
            kind: 'confirmed',
            confirmedAt: container.clock.now(),
          }),
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
        chainAdapters: createTestChainAdapterRegistry({
          signer: createFakeSigner({ address: TREASURY_ADDRESS }),
          balanceReader: createFakeBalanceReader({
            balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
          }),
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
      chainAdapters: createTestChainAdapterRegistry({
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader: createFakeBalanceReader({
          balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
        }),
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

  it('marks runs older than the grace window and leaves an in-flight row unfinished', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const clock = createFixedClock(now);
    const chunks: string[] = [];
    const logger = createLogger({
      level: 'info',
      serviceRole: 'cron-reconciler',
      environment: 'test',
      destination: {
        write(data: string) {
          chunks.push(data);
        },
      },
    });
    const container = buildJobContainer({ fundingEnabled: false, clock, logger });

    const cleanId = randomUUID();
    const oldId = randomUUID();
    const recentId = randomUUID();
    const oldRunId = `old-${randomUUID()}`;
    const recentRunId = `recent-${randomUUID()}`;
    const keptFindings = [
      {
        kind: 'wallet_assessment_failed',
        severity: 'warning',
        walletId: 'wallet-kept',
        reason: 'left unchanged',
      },
    ];
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    await handle.db.insert(reconciliationRuns).values([
      {
        id: cleanId,
        runId: `clean-${randomUUID()}`,
        requestedBy: 'wallet-reconciler',
        startedAt: new Date(twoDaysAgo.getTime() - 30_000),
        finishedAt: twoDaysAgo,
        walletsAssessed: 2,
        walletsFunded: 2,
        walletsNoop: 0,
        walletsBlocked: 0,
        walletsFailed: 0,
        weiTransferred: '10',
        submissionUnknownResolved: 0,
        submissionUnknownLeftPending: 0,
        unexplainedTransferCount: 0,
        outgoingScanStatus: 'complete',
        findingsJson: [],
        errorCode: null,
        errorSummary: null,
      },
      {
        id: oldId,
        runId: oldRunId,
        requestedBy: 'wallet-reconciler',
        startedAt: threeHoursAgo,
        finishedAt: null,
        walletsAssessed: 4,
        walletsFunded: 1,
        walletsNoop: 2,
        walletsBlocked: 1,
        walletsFailed: 0,
        weiTransferred: '42',
        submissionUnknownResolved: 0,
        submissionUnknownLeftPending: 1,
        unexplainedTransferCount: 3,
        outgoingScanStatus: 'complete',
        findingsJson: keptFindings,
        errorCode: null,
        errorSummary: null,
      },
      {
        id: recentId,
        runId: recentRunId,
        requestedBy: 'wallet-reconciler',
        startedAt: fiveMinutesAgo,
        finishedAt: null,
        walletsAssessed: 9,
        walletsFunded: 0,
        walletsNoop: 0,
        walletsBlocked: 0,
        walletsFailed: 0,
        weiTransferred: '0',
        submissionUnknownResolved: 0,
        submissionUnknownLeftPending: 0,
        unexplainedTransferCount: 0,
        outgoingScanStatus: 'not-run',
        findingsJson: [],
        errorCode: null,
        errorSummary: null,
      },
    ]);

    const marker = `corr-${randomUUID()}`;
    expect(await logAbortedReconciliationRuns(container, marker)).toBe(2);

    const rows = await handle.db.select().from(reconciliationRuns);
    const clean = rows.find((row) => row.id === cleanId);
    const old = rows.find((row) => row.id === oldId);
    const recent = rows.find((row) => row.id === recentId);

    expect(old?.finishedAt?.toISOString()).toBe(now.toISOString());
    expect(old?.errorCode).toBe('RUN_ABORTED');
    expect(old?.errorSummary).toBe(
      `Process exited before finish; marked aborted at startup by run ${marker}`,
    );
    expect(old?.startedAt.toISOString()).toBe(threeHoursAgo.toISOString());
    expect(old?.walletsAssessed).toBe(4);
    expect(old?.walletsFunded).toBe(1);
    expect(old?.walletsNoop).toBe(2);
    expect(old?.walletsBlocked).toBe(1);
    expect(old?.walletsFailed).toBe(0);
    expect(old?.weiTransferred).toBe('42');
    expect(old?.submissionUnknownLeftPending).toBe(1);
    expect(old?.unexplainedTransferCount).toBe(3);
    expect(old?.outgoingScanStatus).toBe('complete');
    expect(old?.findingsJson).toEqual(keptFindings);

    expect(recent?.finishedAt).toBeNull();
    expect(recent?.errorCode).toBeNull();
    expect(recent?.errorSummary).toBeNull();
    expect(recent?.walletsAssessed).toBe(9);
    expect(recent?.outgoingScanStatus).toBe('not-run');

    expect(clean?.finishedAt?.toISOString()).toBe(twoDaysAgo.toISOString());
    expect(clean?.errorCode).toBeNull();
    expect(clean?.walletsAssessed).toBe(2);
    expect(clean?.weiTransferred).toBe('10');

    const latest = await container.repositories.reconciliationRuns.findLatestFinished();
    expect(latest?.id).toBe(cleanId);
    expect(latest?.errorCode).toBeUndefined();

    const firstWarnings = abortedRunWarnings(chunks);
    expect(firstWarnings.filter((entry) => entry.markedAborted === true)).toHaveLength(1);
    expect(firstWarnings.filter((entry) => entry.markedAborted === false)).toHaveLength(1);
    expect(JSON.stringify(firstWarnings)).toContain(oldRunId);
    expect(JSON.stringify(firstWarnings)).toContain(recentRunId);

    chunks.length = 0;
    clock.advance(60_000);
    const secondMarker = `corr-${randomUUID()}`;
    expect(await logAbortedReconciliationRuns(container, secondMarker)).toBe(1);

    const after = await handle.db.select().from(reconciliationRuns);
    const oldAfter = after.find((row) => row.id === oldId);
    const recentAfter = after.find((row) => row.id === recentId);
    const cleanAfter = after.find((row) => row.id === cleanId);
    expect(oldAfter?.finishedAt?.toISOString()).toBe(now.toISOString());
    expect(oldAfter?.errorSummary).toContain(marker);
    expect(oldAfter?.errorSummary).not.toContain(secondMarker);
    expect(oldAfter?.walletsAssessed).toBe(4);
    expect(oldAfter?.outgoingScanStatus).toBe('complete');
    expect(recentAfter?.finishedAt).toBeNull();
    expect(recentAfter?.errorCode).toBeNull();
    expect(cleanAfter?.finishedAt?.toISOString()).toBe(twoDaysAgo.toISOString());
    expect(cleanAfter?.errorCode).toBeNull();

    const secondWarnings = abortedRunWarnings(chunks);
    expect(secondWarnings).toHaveLength(1);
    expect(secondWarnings[0]?.markedAborted).toBe(false);
    expect(JSON.stringify(secondWarnings[0]?.abortedRuns)).toContain(recentRunId);
    expect(JSON.stringify(secondWarnings[0]?.abortedRuns)).not.toContain(oldRunId);

    const latestAfter = await container.repositories.reconciliationRuns.findLatestFinished();
    expect(latestAfter?.id).toBe(cleanId);
  });

  function buildJobContainer(options: {
    readonly fundingEnabled: boolean;
    readonly database?: Container['database'];
    readonly close?: () => Promise<void>;
    readonly clock?: Container['clock'];
    readonly logger?: Container['logger'];
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
    const logger =
      options.logger ??
      createLogger({ level: 'silent', serviceRole: 'cron-reconciler', environment: 'test' });
    const clock = options.clock ?? createFixedClock();
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
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader: createFakeBalanceReader({
          balances: { [TREASURY_ADDRESS]: 20n * ONE_ETH, [WALLET_A_ADDRESS]: 0n },
        }),
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        receiptTracker: createFakeReceiptTracker({
          kind: 'confirmed',
          confirmedAt: clock.now(),
        }),
        outgoingScanner: createFakeOutgoingScanner(),
      }),
      fundingDispatchLock: createFundingDispatchLock(database.db),
      operatorMutations: createOperatorMutationTransaction(database.db),
      emailSender: {
        send() {
          return Promise.resolve({ kind: 'sent' as const, providerMessageId: `msg-${randomUUID()}` });
        },
      },
      close: options.close ?? (async () => {}),
    };
  }
});
