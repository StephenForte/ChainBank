import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import { registerConfiguredTreasury } from '../../src/app/bootstrap/register-configured-treasury.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
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
  auditEvents,
  fundingPolicies,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import {
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
const NEW_TREASURY_ADDRESS = '0x3333333333333333333333333333333333333333';
const OLD_TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';

describe.skipIf(!integrationEnabled)('treasury row lifecycle / rotation (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let signer: TreasurySigner & { readonly sendCalls: number };

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

    // Signer matches the *new* treasury address — the post-rotation config.
    signer = createFakeSigner({ address: getAddress(NEW_TREASURY_ADDRESS) });

    const balanceReader: BalanceReader = {
      chainId: 11_155_111,
      readBalance(request) {
        const normalized = request.address.toLowerCase();
        const isTreasury =
          normalized === OLD_TREASURY_ADDRESS.toLowerCase() ||
          normalized === NEW_TREASURY_ADDRESS.toLowerCase();
        return Promise.resolve({
          kind: 'observed',
          balanceWei: isTreasury ? 20n * ONE_ETH : ONE_ETH / 10n,
          blockNumber: 42n,
          observedAt: new Date('2026-08-01T12:00:00.000Z'),
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
        TREASURY_ADDRESS: NEW_TREASURY_ADDRESS,
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
        fundingHealth: {} as Container['repositories']['fundingHealth'],
      },
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader,
        signer,
        receiptTracker: createFakeReceiptTracker({
          kind: 'confirmed',
          confirmedAt: new Date('2026-08-01T12:00:01.000Z'),
        }),
      }),
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      operatorMutations: createOperatorMutationTransaction(handle.db),
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

  it('walks the C12 rotation path: disable retired → insert successor → fund', async () => {
    const treasuryRepo = createTreasuryRepository(handle.db);
    const chainRepo = createChainRepository(handle.db);

    // C23 / 0010: a second enabled row of the same kind cannot exist. Rotation
    // is disable-then-insert, not insert-then-disable.
    const disableResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/treasuries/${seed.treasuryId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { enabled: false },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      data: { id: seed.treasuryId, enabled: false },
    });

    const newRow = await registerConfiguredTreasury(
      { chains: chainRepo, treasuries: treasuryRepo },
      {
        chain: {
          slug: 'sepolia',
          chainId: 11_155_111,
          displayName: 'Sepolia',
          nativeSymbol: 'ETH',
          explorerBaseUrl: 'https://sepolia.etherscan.io',
        },
        treasuryAddress: NEW_TREASURY_ADDRESS.toLowerCase(),
        treasuryAddressDisplay: getAddress(NEW_TREASURY_ADDRESS),
        kind: 'external',
        policy: undefined,
        thresholds: {
          warningBalanceWei: ONE_ETH,
          criticalBalanceWei: ONE_ETH / 4n,
          recoveryBalanceWei: 2n * ONE_ETH,
          minimumReserveWei: ONE_ETH / 10n,
        },
      },
    );

    const remaining = await treasuryRepo.listEnabled();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(newRow.id);
    expect(remaining[0]?.address).toBe(NEW_TREASURY_ADDRESS.toLowerCase());

    const auditRows = await handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'treasury.disabled'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.entityId).toBe(seed.treasuryId);

    const fundResponse = await app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.managedWalletId}/ensure-funded`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { idempotencyKey: 'rotation-fund' },
    });
    expect(fundResponse.statusCode).toBe(200);
    expect(fundResponse.json()).toMatchObject({
      data: { status: 'funded' },
    });
    expect(signer.sendCalls).toBe(1);
  });

  it('refuses enabling a second external on the same chain and leaves the first enabled', async () => {
    const [retired] = await handle.db
      .insert(treasuries)
      .values({
        chainId: seed.chainId,
        address: NEW_TREASURY_ADDRESS.toLowerCase(),
        addressDisplay: getAddress(NEW_TREASURY_ADDRESS),
        warningBalanceWei: ONE_ETH.toString(),
        criticalBalanceWei: (ONE_ETH / 4n).toString(),
        recoveryBalanceWei: (2n * ONE_ETH).toString(),
        minimumReserveWei: (ONE_ETH / 10n).toString(),
        kind: 'external',
        enabled: false,
      })
      .returning({ id: treasuries.id });

    if (retired === undefined) {
      throw new Error('Expected retired treasury row');
    }

    const enableResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/treasuries/${retired.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(400);
    expect(enableResponse.json()).toMatchObject({
      error: {
        code: 'INVALID_CONFIGURATION',
        message: 'Funding is unavailable because treasury configuration is ambiguous for this chain.',
      },
    });
    expect(signer.sendCalls).toBe(0);

    const seedRow = await handle.db.query.treasuries.findFirst({
      where: eq(treasuries.id, seed.treasuryId),
    });
    const retiredRow = await handle.db.query.treasuries.findFirst({
      where: eq(treasuries.id, retired.id),
    });
    expect(seedRow?.enabled).toBe(true);
    expect(retiredRow?.enabled).toBe(false);
  });

  it('re-enabling the same already-enabled row is a no-op success', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/treasuries/${seed.treasuryId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { id: seed.treasuryId, enabled: true },
    });

    const row = await handle.db.query.treasuries.findFirst({
      where: eq(treasuries.id, seed.treasuryId),
    });
    expect(row?.enabled).toBe(true);
  });

  it('rejects non-operator PATCH /v1/treasuries/:id', async () => {
    const readOnly = generateApiToken();
    await handle.db.insert(apiCredentials).values({
      name: `readonly-${randomUUID()}`,
      role: 'read-only',
      tokenHash: readOnly.tokenHash,
      tokenPrefix: readOnly.tokenPrefix,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/treasuries/${seed.treasuryId}`,
      headers: { authorization: `Bearer ${readOnly.token}` },
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_ROLE' },
    });

    const row = await handle.db.query.treasuries.findFirst({
      where: eq(treasuries.id, seed.treasuryId),
    });
    expect(row?.enabled).toBe(true);
  });

  it('returns 404 for an unknown treasury id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/treasuries/cccccccc-cccc-cccc-cccc-cccccccccccc',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'TREASURY_NOT_FOUND' },
    });
  });

  it('rejects unknown body fields on PATCH /v1/treasuries/:id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/treasuries/${seed.treasuryId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { enabled: false, address: '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });
});
