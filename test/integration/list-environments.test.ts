import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import { apiCredentials } from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { createFakeReceiptTracker } from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';
import { validWebEnv } from '../support/env.js';
import type { AppInstance } from '../../src/api/types.js';

describe.skipIf(!integrationEnabled)('GET /v1/projects/:id/environments (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let app: AppInstance;
  let operatorToken: string;
  let projectId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);

    const projectRepo = createProjectRepository(handle.db);
    const createdProject = await projectRepo.insert({ slug: 'fortel2', name: 'ForteL2' });
    projectId = createdProject.id;

    const generated = generateApiToken();
    operatorToken = generated.token;
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
    });

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
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
        projects: projectRepo,
        environments: createEnvironmentRepository(handle.db),
        credentialScopes: createCredentialScopeRepository(handle.db),
        fundingOperations: createFundingOperationRepository(handle.db),
        fundingTransactions: createFundingTransactionRepository(handle.db),
        alerts: createAlertRepository(handle.db),
        reconciliationRuns: {} as Container['repositories']['reconciliationRuns'],
        reconciliationFunding: {} as Container['repositories']['reconciliationFunding'],
      },
      balanceReader: {
        readBalance: () =>
          Promise.resolve({
            kind: 'observed',
            balanceWei: 0n,
            blockNumber: 1n,
            observedAt: new Date(),
          }),
        verifyChainId: () => Promise.resolve({ matches: true, observedChainId: 11_155_111 }),
      },
      treasurySigner: undefined,
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({ kind: 'pending' }),
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

  it('lists a freshly created environment with zero wallets via the HTTP route', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      payload: { slug: 'fresh-env', name: 'Fresh Environment' },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{ data: { id: string; slug: string } }>();

    const listResponse = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/environments?limit=50&offset=0`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(listResponse.statusCode).toBe(200);
    const body = listResponse.json<{
      data: readonly { id: string; slug: string }[];
      pagination: { limit: number; offset: number; total: number };
    }>();
    expect(body.pagination).toEqual({ limit: 50, offset: 0, total: 1 });
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe(created.data.id);
    expect(body.data[0]?.slug).toBe('fresh-env');
  });

  it('orders environments by createdAt ASC in the repository', async () => {
    const envRepo = createEnvironmentRepository(handle.db);
    const first = await envRepo.insert({ projectId, slug: 'alpha', name: 'Alpha' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await envRepo.insert({ projectId, slug: 'beta', name: 'Beta' });

    const page = await envRepo.listByProject(projectId, { limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
  });
});
