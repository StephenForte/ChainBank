import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import type { BalanceReader } from '../../src/app/ports.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import { apiCredentials, apiCredentialScopes, projects } from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { createFakeReceiptTracker, createFakeSigner } from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';
import { validWebEnv } from '../support/env.js';
import type { AppInstance } from '../../src/api/types.js';

const ONE_ETH = 10n ** 18n;
const OBSERVED_AT = new Date('2026-08-02T15:00:00.000Z');

describe.skipIf(!integrationEnabled)('GET /v1/wallets/:id/balance (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let readOnlyToken: string;
  let projectServiceToken: string;
  let projectServiceCredentialId: string;
  let balanceMode: 'observed' | 'unavailable' = 'observed';
  let readBalanceCalls: string[];

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);
    balanceMode = 'observed';
    readBalanceCalls = [];

    const operator = generateApiToken();
    operatorToken = operator.token;
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: operator.tokenHash,
      tokenPrefix: operator.tokenPrefix,
    });

    const readOnly = generateApiToken();
    readOnlyToken = readOnly.token;
    await handle.db.insert(apiCredentials).values({
      name: `readonly-${randomUUID()}`,
      role: 'read-only',
      tokenHash: readOnly.tokenHash,
      tokenPrefix: readOnly.tokenPrefix,
    });

    const projectService = generateApiToken();
    projectServiceToken = projectService.token;
    const [credential] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `project-service-${randomUUID()}`,
        role: 'project-service',
        tokenHash: projectService.tokenHash,
        tokenPrefix: projectService.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (credential === undefined) {
      throw new Error('Failed to seed project-service credential');
    }
    projectServiceCredentialId = credential.id;
    await handle.db.insert(apiCredentialScopes).values({
      credentialId: projectServiceCredentialId,
      projectId: seed.projectId,
      environmentId: null,
    });

    const balanceReader: BalanceReader = {
      readBalance(address) {
        readBalanceCalls.push(address);
        if (balanceMode === 'unavailable') {
          return Promise.resolve({
            kind: 'unavailable',
            errorCode: 'RPC_UNAVAILABLE',
            reason: 'integration stub: provider down',
            observedAt: OBSERVED_AT,
          });
        }
        return Promise.resolve({
          kind: 'observed',
          balanceWei: ONE_ETH / 4n,
          blockNumber: 11405512n,
          observedAt: OBSERVED_AT,
        });
      },
      verifyChainId() {
        return Promise.resolve({ matches: true, observedChainId: 11_155_111 });
      },
    };

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    });
    const clock = createFixedClock();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    container = {
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
      },
      balanceReader,
      treasurySigner: createFakeSigner({}),
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      operatorMutations: createOperatorMutationTransaction(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: OBSERVED_AT,
      }),
      treasuryOutgoingScanner: {} as Container['treasuryOutgoingScanner'],
      emailSender: undefined,
      close: () => Promise.resolve(),
    };

    if (app !== undefined) {
      await app.close();
    }
    app = await buildApp(container);
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    await handle.close();
  });

  it('returns an observed balance for operator without writing observations', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${seed.managedWalletId}/balance`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      balance: {
        outcome: 'observed',
        wei: (ONE_ETH / 4n).toString(),
        ether: '0.25',
        blockNumber: '11405512',
        observedAt: OBSERVED_AT.toISOString(),
      },
    });
    expect(readBalanceCalls).toHaveLength(1);
    expect(readBalanceCalls[0]?.toLowerCase()).toBe('0x2222222222222222222222222222222222222222');

    const observations = await handle.pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM balance_observations',
    );
    expect(observations.rows[0]?.count).toBe(0);
  });

  it('returns an observed balance for read-only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${seed.managedWalletId}/balance`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balance: { outcome: 'observed' } });
  });

  it('allows in-scope project-service and denies out-of-scope with 403', async () => {
    const inScope = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${seed.managedWalletId}/balance`,
      headers: { authorization: `Bearer ${projectServiceToken}` },
    });
    expect(inScope.statusCode).toBe(200);
    expect(inScope.json()).toMatchObject({ balance: { outcome: 'observed', ether: '0.25' } });

    const [otherProject] = await handle.db
      .insert(projects)
      .values({ slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' })
      .returning({ id: projects.id });
    if (otherProject === undefined) {
      throw new Error('Failed to seed other project');
    }

    // Re-scope the credential to the other project only.
    await handle.pool.query('DELETE FROM api_credential_scopes WHERE credential_id = $1', [
      projectServiceCredentialId,
    ]);
    await handle.db.insert(apiCredentialScopes).values({
      credentialId: projectServiceCredentialId,
      projectId: otherProject.id,
      environmentId: null,
    });

    const outOfScope = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${seed.managedWalletId}/balance`,
      headers: { authorization: `Bearer ${projectServiceToken}` },
    });
    expect(outOfScope.statusCode).toBe(403);
    expect(outOfScope.json()).toMatchObject({ error: { code: 'SCOPE_DENIED' } });
    // Scope denial must happen before the RPC read.
    expect(readBalanceCalls).toHaveLength(1);
  });

  it('returns 404 for an unknown wallet id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${randomUUID()}/balance`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'WALLET_NOT_FOUND' } });
    expect(readBalanceCalls).toHaveLength(0);
  });

  it('returns unavailable without wei fields when the provider fails', async () => {
    balanceMode = 'unavailable';
    const response = await app.inject({
      method: 'GET',
      url: `/v1/wallets/${seed.managedWalletId}/balance`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      balance: {
        outcome: string;
        errorCode?: string;
        wei?: string;
        ether?: string;
      };
    }>();
    expect(body.balance).toEqual({
      outcome: 'unavailable',
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'integration stub: provider down',
      observedAt: OBSERVED_AT.toISOString(),
    });
    expect(body.balance).not.toHaveProperty('wei');
    expect(body.balance).not.toHaveProperty('ether');
  });
});
