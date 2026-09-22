import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generatePrivateKey } from 'viem/accounts';
import {
  RECONCILIATION_FAILURE_ALERT_TYPE,
  classifyReconciliationRun,
} from '../../src/app/alerts/notify-reconciliation-failure.js';
import {
  TREASURY_ALERT_ENTITY_TYPE,
  TREASURY_BALANCE_ALERT_TYPE,
} from '../../src/app/alerts/evaluate-treasury-alerts.js';
import { registerConfiguredTreasuries } from '../../src/app/bootstrap/register-configured-treasury.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
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
  chains,
  fundingPolicies,
  managedWallets,
  serviceHeartbeats,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import { runTreasuryMonitor } from '../../src/jobs/treasury-monitor.js';
import {
  HEARTBEAT_SERVICE_ROLE,
  buildReconcileWalletsDependencies,
  runWalletReconciler,
} from '../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../src/observability/logger.js';
import { createFixedClock } from '../support/clock.js';
import { validMonitorEnv, validWebEnv } from '../support/env.js';
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
const SEPOLIA_CHAIN_ID = 11_155_111;
const BASE_CHAIN_ID = 84_532;
const SEPOLIA_EXTERNAL = '0x1111111111111111111111111111111111111111';
const SEPOLIA_OPERATIONAL = '0x5555555555555555555555555555555555555555';
const BASE_EXTERNAL = '0x4444444444444444444444444444444444444444';
const BASE_OPERATIONAL = '0x6666666666666666666666666666666666666666';
const SEPOLIA_WALLET = '0x2222222222222222222222222222222222222222';
const BASE_WALLET = '0x3333333333333333333333333333333333333333';

describe.skipIf(!integrationEnabled)('per-chain cron isolation (C29)', () => {
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

  it('reads and alerts the healthy treasury when the other chain RPC fails', async () => {
    const container = buildContainer({
      role: 'treasury-monitor',
      fundingEnabled: false,
      adapters: monitorAdapters(),
    });
    const registered = await registerConfiguredTreasuries(
      { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
      container.config,
    );
    const sepolia = registered.chains.find((entry) => entry.chainId === SEPOLIA_CHAIN_ID);
    const base = registered.chains.find((entry) => entry.chainId === BASE_CHAIN_ID);
    if (sepolia === undefined || base === undefined) {
      throw new Error('both chains must be registered');
    }

    const openedAt = new Date('2026-09-01T00:00:00.000Z');
    const sepoliaAlert = await container.repositories.alerts.insertOpen({
      alertType: TREASURY_BALANCE_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: sepolia.external.id,
      firstTriggeredAt: openedAt,
      lastEvaluatedAt: openedAt,
      pendingEmail: 'critical',
      metadata: {},
    });
    const baseAlert = await container.repositories.alerts.insertOpen({
      alertType: TREASURY_BALANCE_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: base.external.id,
      firstTriggeredAt: openedAt,
      lastEvaluatedAt: openedAt,
      pendingEmail: 'critical',
      metadata: {},
    });

    await expect(runTreasuryMonitor(container, `corr-${randomUUID()}`)).rejects.toThrow(
      'One or more treasury balances could not be read',
    );

    const sepoliaRow = await container.repositories.alerts.findById(sepoliaAlert.id);
    const baseRow = await container.repositories.alerts.findById(baseAlert.id);
    expect(sepoliaRow?.state).toBe('resolved');
    expect(baseRow?.state).toBe('open');

    const treasuryRows = await handle.db.select().from(treasuries);
    const sepoliaExternal = treasuryRows.find((row) => row.id === sepolia.external.id);
    const baseExternal = treasuryRows.find((row) => row.id === base.external.id);
    expect(sepoliaExternal?.lastObservedBalanceWei).toBe((10n * ONE_ETH).toString());
    expect(baseExternal?.lastObservedBalanceWei).toBeNull();
    expect(baseExternal?.lastCheckErrorCode).toBe('RPC_UNAVAILABLE');

    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    const detail = heartbeats.find((row) => row.serviceRole === 'treasury-monitor')?.detail as {
      outcome?: string;
      chainOutcomes?: readonly { chainId: number; status: string }[];
    };
    expect(detail.outcome).toBe('unavailable');
    expect(detail.chainOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chainId: SEPOLIA_CHAIN_ID, status: 'processed' }),
        expect.objectContaining({ chainId: BASE_CHAIN_ID, status: 'unavailable' }),
      ]),
    );
  });

  it('still throws when the only configured chain cannot be read', async () => {
    const container = buildContainer({
      role: 'treasury-monitor',
      fundingEnabled: false,
      chainIds: [SEPOLIA_CHAIN_ID],
      adapters: createTestChainAdapterRegistry({
        chainId: SEPOLIA_CHAIN_ID,
        balanceReader: createFakeBalanceReader({
          chainId: SEPOLIA_CHAIN_ID,
          unavailable: {
            [SEPOLIA_EXTERNAL]: 'RPC_UNAVAILABLE',
            [SEPOLIA_OPERATIONAL]: 'RPC_UNAVAILABLE',
          },
        }),
      }),
    });

    await expect(runTreasuryMonitor(container, `corr-${randomUUID()}`)).rejects.toThrow(
      'One or more treasury balances could not be read',
    );

    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    const detail = heartbeats.find((row) => row.serviceRole === 'treasury-monitor')?.detail as {
      outcome?: string;
      chainOutcomes?: readonly { chainId: number; status: string }[];
    };
    expect(detail.outcome).toBe('unavailable');
    expect(detail.chainOutcomes).toEqual([
      expect.objectContaining({ chainId: SEPOLIA_CHAIN_ID, status: 'unavailable' }),
    ]);
  });

  it('funds the healthy chain when the other chain RPC fails and does not classify success', async () => {
    const [baseChain] = await handle.db
      .insert(chains)
      .values({
        slug: 'base-sepolia',
        chainId: BASE_CHAIN_ID,
        displayName: 'Base Sepolia',
        nativeSymbol: 'ETH',
        explorerBaseUrl: 'https://sepolia.basescan.org',
      })
      .returning({ id: chains.id });
    if (baseChain === undefined) {
      throw new Error('base chain insert failed');
    }
    const [baseWallet] = await handle.db
      .insert(managedWallets)
      .values({
        environmentId: seed.environmentId,
        chainId: baseChain.id,
        role: 'signer',
        address: BASE_WALLET,
        reconciliationEnabled: true,
      })
      .returning({ id: managedWallets.id });
    if (baseWallet === undefined) {
      throw new Error('base wallet insert failed');
    }
    await handle.db.insert(fundingPolicies).values({
      managedWalletId: baseWallet.id,
      minimumBalanceWei: ONE_ETH.toString(),
      targetBalanceWei: (2n * ONE_ETH).toString(),
      maximumTopUpWei: (5n * ONE_ETH).toString(),
      version: 1,
    });

    const sepoliaSigner = createFakeSigner({ chainId: SEPOLIA_CHAIN_ID, address: SEPOLIA_OPERATIONAL });
    const container = buildContainer({
      role: 'cron-reconciler',
      fundingEnabled: true,
      adapters: reconcilerAdapters({ baseUnavailable: true, sepoliaSigner }),
    });
    const registered = await registerConfiguredTreasuries(
      { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
      container.config,
    );
    const base = registered.chains.find((entry) => entry.chainId === BASE_CHAIN_ID);
    if (base?.operational === undefined) {
      throw new Error('base operational treasury missing');
    }
    const openedAt = new Date('2026-09-01T00:00:00.000Z');
    const baseAlert = await container.repositories.alerts.insertOpen({
      alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: base.operational.id,
      firstTriggeredAt: openedAt,
      lastEvaluatedAt: openedAt,
      pendingEmail: 'critical',
      metadata: {},
    });

    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: buildReconcileWalletsDependencies(container, {
        chainAdapters: container.chainAdapters,
        isFundingEnabled: true,
        isFundingKillSwitchActive: false,
      }),
    });

    const reconcileResult = outcome.reconcileResult;
    if (reconcileResult === undefined) {
      throw new Error('reconciler returned no result');
    }
    expect(sepoliaSigner.sendCalls).toBe(1);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.exitKind).toBe('malfunction');
    expect(reconcileResult.counters.funded).toBe(1);
    expect(reconcileResult.run.errorCode).toBeUndefined();
    expect(classifyReconciliationRun(reconcileResult.run)).toBe('failure');
    expect(reconcileResult.run.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'chain_outcome', chainId: SEPOLIA_CHAIN_ID, status: 'processed' }),
        expect.objectContaining({ kind: 'chain_outcome', chainId: BASE_CHAIN_ID, status: 'unavailable' }),
      ]),
    );

    const stillOpen = await container.repositories.alerts.findById(baseAlert.id);
    expect(stillOpen?.state).toBe('open');

    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    const detail = heartbeats.find((row) => row.serviceRole === HEARTBEAT_SERVICE_ROLE)?.detail as {
      exitKind?: string;
      chainOutcomes?: readonly { chainId: number; status: string }[];
    };
    expect(detail.exitKind).toBe('malfunction');
    expect(detail.chainOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chainId: SEPOLIA_CHAIN_ID, status: 'processed' }),
        expect.objectContaining({ chainId: BASE_CHAIN_ID, status: 'unavailable' }),
      ]),
    );
  });

  it('keeps a healthy two-chain reconciler on exit 0', async () => {
    const sepoliaSigner = createFakeSigner({ chainId: SEPOLIA_CHAIN_ID, address: SEPOLIA_OPERATIONAL });
    const baseSigner = createFakeSigner({ chainId: BASE_CHAIN_ID, address: BASE_OPERATIONAL });
    const container = buildContainer({
      role: 'cron-reconciler',
      fundingEnabled: true,
      adapters: reconcilerAdapters({ baseUnavailable: false, sepoliaSigner, baseSigner }),
    });

    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: buildReconcileWalletsDependencies(container, {
        chainAdapters: container.chainAdapters,
        isFundingEnabled: true,
        isFundingKillSwitchActive: false,
      }),
    });

    const reconcileResult = outcome.reconcileResult;
    if (reconcileResult === undefined) {
      throw new Error('reconciler returned no result');
    }
    expect(outcome.exitCode).toBe(0);
    expect(outcome.exitKind).toBe('success');
    expect(classifyReconciliationRun(reconcileResult.run)).toBe('success');
    const heartbeats = await handle.db.select().from(serviceHeartbeats);
    const detail = heartbeats.find((row) => row.serviceRole === HEARTBEAT_SERVICE_ROLE)?.detail as {
      exitKind?: string;
      errorCode?: string;
      walletsFunded?: number;
    };
    expect(detail.exitKind).toBe('success');
    expect(detail.errorCode).toBeUndefined();
    expect(detail.walletsFunded).toBe(reconcileResult.counters.funded);
  });

  function monitorAdapters() {
    return createTestChainAdapterRegistry({
      chainId: SEPOLIA_CHAIN_ID,
      balanceReader: createFakeBalanceReader({
        chainId: SEPOLIA_CHAIN_ID,
        balances: {
          [SEPOLIA_EXTERNAL]: 10n * ONE_ETH,
          [SEPOLIA_OPERATIONAL]: 10n * ONE_ETH,
        },
      }),
      extraChains: [
        {
          chainId: BASE_CHAIN_ID,
          balanceReader: createFakeBalanceReader({
            chainId: BASE_CHAIN_ID,
            unavailable: {
              [BASE_EXTERNAL]: 'RPC_UNAVAILABLE',
              [BASE_OPERATIONAL]: 'RPC_UNAVAILABLE',
            },
          }),
        },
      ],
    });
  }

  function reconcilerAdapters(input: {
    readonly baseUnavailable: boolean;
    readonly sepoliaSigner: ReturnType<typeof createFakeSigner>;
    readonly baseSigner?: ReturnType<typeof createFakeSigner>;
  }) {
    const baseReader = input.baseUnavailable
      ? createFakeBalanceReader({
          chainId: BASE_CHAIN_ID,
          unavailable: {
            [BASE_EXTERNAL]: 'RPC_UNAVAILABLE',
            [BASE_OPERATIONAL]: 'RPC_UNAVAILABLE',
            [BASE_WALLET]: 'RPC_UNAVAILABLE',
          },
        })
      : createFakeBalanceReader({
          chainId: BASE_CHAIN_ID,
          balances: {
            [BASE_EXTERNAL]: 20n * ONE_ETH,
            [BASE_OPERATIONAL]: 20n * ONE_ETH,
            [BASE_WALLET]: 5n * ONE_ETH,
          },
        });
    return createTestChainAdapterRegistry({
      chainId: SEPOLIA_CHAIN_ID,
      balanceReader: createFakeBalanceReader({
        chainId: SEPOLIA_CHAIN_ID,
        balances: {
          [SEPOLIA_EXTERNAL]: 20n * ONE_ETH,
          [SEPOLIA_OPERATIONAL]: 20n * ONE_ETH,
          [SEPOLIA_WALLET]: ONE_ETH / 10n,
        },
      }),
      signer: input.sepoliaSigner,
      externalSigner: createFakeSigner({ chainId: SEPOLIA_CHAIN_ID, address: SEPOLIA_EXTERNAL }),
      outgoingScanner: createFakeOutgoingScanner(),
      receiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      extraChains: [
        {
          chainId: BASE_CHAIN_ID,
          balanceReader: baseReader,
          outgoingScanner: input.baseUnavailable
            ? createFakeOutgoingScanner({
                latestBlockUnavailable: { errorCode: 'RPC_UNAVAILABLE', reason: 'base tip down' },
              })
            : createFakeOutgoingScanner(),
          ...(input.baseSigner === undefined ? {} : { signer: input.baseSigner }),
          externalSigner: createFakeSigner({ chainId: BASE_CHAIN_ID, address: BASE_EXTERNAL }),
        },
      ],
    });
  }

  function buildContainer(input: {
    readonly role: 'treasury-monitor' | 'cron-reconciler';
    readonly fundingEnabled: boolean;
    readonly chainIds?: readonly number[];
    readonly adapters: Container['chainAdapters'];
  }): Container {
    const privateKey = generatePrivateKey();
    const operationalKey = generatePrivateKey();
    const chainIds = input.chainIds ?? [SEPOLIA_CHAIN_ID, BASE_CHAIN_ID];
    const config = loadConfig({
      serviceRole: input.role,
      env: chainEnv({
        role: input.role,
        fundingEnabled: input.fundingEnabled,
        chainIds,
        privateKey,
        operationalKey,
      }),
    });
    const logger = createLogger({ level: 'silent', serviceRole: input.role, environment: 'test' });
    const clock = createFixedClock(new Date('2026-09-21T00:00:00.000Z'));
    const database = {
      db: handle.db,
      pool: handle.pool,
      close: async () => {},
    } satisfies Container['database'];

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
      chainAdapters: input.adapters,
      fundingDispatchLock: createFundingDispatchLock(database.db),
      operatorMutations: createOperatorMutationTransaction(database.db),
      emailSender: {
        send() {
          return Promise.resolve({ kind: 'sent' as const, providerMessageId: `msg-${randomUUID()}` });
        },
      },
      close: async () => {},
    };
  }
});

function chainEnv(input: {
  readonly role: 'treasury-monitor' | 'cron-reconciler';
  readonly fundingEnabled: boolean;
  readonly chainIds: readonly number[];
  readonly privateKey: string;
  readonly operationalKey: string;
}): NodeJS.ProcessEnv {
  const base = input.role === 'treasury-monitor' ? validMonitorEnv() : validWebEnv();
  const env: NodeJS.ProcessEnv = {
    ...base,
    DATABASE_URL: process.env.DATABASE_URL,
    FUNDING_ENABLED: input.fundingEnabled ? 'true' : 'false',
    FUNDING_KILL_SWITCH: 'false',
    ...(input.fundingEnabled
      ? {
          TREASURY_PRIVATE_KEY: input.privateKey,
          TREASURY_OPERATIONAL_PRIVATE_KEY: input.operationalKey,
        }
      : {}),
  };
  for (const key of [
    'CHAIN_ID',
    'CHAIN_RPC_URL',
    'TREASURY_ADDRESS',
    'TREASURY_WARNING_BALANCE_ETH',
    'TREASURY_CRITICAL_BALANCE_ETH',
    'TREASURY_RECOVERY_BALANCE_ETH',
    'TREASURY_MINIMUM_RESERVE_ETH',
  ]) {
    delete env[key];
  }
  const treasury = {
    address: SEPOLIA_EXTERNAL,
    warningBalanceEth: '1',
    criticalBalanceEth: '0.25',
    recoveryBalanceEth: '2',
    minimumReserveEth: '0.1',
  };
  const operational = {
    address: SEPOLIA_OPERATIONAL,
    warningBalanceEth: '0.2',
    criticalBalanceEth: '0.1',
    recoveryBalanceEth: '0.4',
    minimumReserveEth: '0.05',
    minimumBalanceEth: '0.15',
    targetBalanceEth: '0.3',
    maximumTopUpEth: '0.2',
  };
  const documents = [
    {
      chainId: SEPOLIA_CHAIN_ID,
      rpcUrl: 'https://rpc.example.test/sepolia',
      treasury,
      operationalTreasury: operational,
    },
    {
      chainId: BASE_CHAIN_ID,
      rpcUrl: 'https://rpc.example.test/base-sepolia',
      treasury: { ...treasury, address: BASE_EXTERNAL },
      operationalTreasury: { ...operational, address: BASE_OPERATIONAL },
    },
  ].filter((document) => input.chainIds.includes(document.chainId));
  env.CHAINS = JSON.stringify(documents);
  return env;
}
