import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
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
import { apiCredentials, fundingPolicies } from '../../src/infrastructure/db/schema.js';
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
import { generatePrivateKey } from 'viem/accounts';
import { validWebEnv } from '../support/env.js';
import type { AppInstance } from '../../src/api/types.js';

const ONE_ETH = 10n ** 18n;

describe.skipIf(!integrationEnabled)('POST /v1/wallets/:id/ensure-funded (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let signer: TreasurySigner & { readonly sendCalls: number };
  let sendDestinations: string[];

  beforeAll(async () => {
    handle = createIntegrationDatabase();
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
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
    });

    sendDestinations = [];
    signer = createFakeSigner({
      send: (input) => {
        sendDestinations.push(input.to);
        return Promise.resolve({ transactionHash: `0x${'ab'.repeat(32)}` });
      },
    });

    const balanceReader: BalanceReader = {
      readBalance(address) {
        const normalized = address.toLowerCase();
        const balanceWei =
          normalized === '0x1111111111111111111111111111111111111111' ? 20n * ONE_ETH : ONE_ETH / 10n;
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

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: generatePrivateKey(),
        TREASURY_ADDRESS: '0x1111111111111111111111111111111111111111',
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
      treasurySigner: signer,
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: new Date('2026-07-29T12:00:01.000Z'),
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

  it('funds a managed wallet and replays the same idempotency key', async () => {
    const path = `/v1/wallets/${seed.managedWalletId}/ensure-funded`;
    const body = { idempotencyKey: 'integration-ensure-1' };

    const first = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const firstJson = first.json<{
      data: { status: string; operationId: string; transferredWei: string | null };
    }>();
    expect(firstJson.data.status).toBe('funded');
    expect(firstJson.data.transferredWei).toBe((2n * ONE_ETH - ONE_ETH / 10n).toString());
    expect(signer.sendCalls).toBe(1);
    expect(sendDestinations).toEqual(['0x2222222222222222222222222222222222222222']);

    const second = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    const secondJson = second.json<{
      data: { status: string; operationId: string };
    }>();
    expect(secondJson.data.operationId).toBe(firstJson.data.operationId);
    expect(signer.sendCalls).toBe(1);
  });

  it('rejects an arbitrary address in the request body before it can reach the signer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.managedWalletId}/ensure-funded`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        idempotencyKey: 'evil-address',
        address: '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('returns FUNDING_DISABLED without calling the signer when funding is off', async () => {
    await app.close();
    app = await buildApp({
      ...container,
      config: {
        ...container.config,
        isFundingEnabled: false,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.managedWalletId}/ensure-funded`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { idempotencyKey: 'disabled-1' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'FUNDING_DISABLED' },
    });
    expect(signer.sendCalls).toBe(0);
  });
});
