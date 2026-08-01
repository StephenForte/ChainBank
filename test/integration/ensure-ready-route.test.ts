import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { getAddress } from 'viem';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { TREASURY_RESERVE_ALERT_TYPE } from '../../src/app/alerts/notify-treasury-reserve-alert.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
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
import { apiCredentials, fundingPolicies, fundingTransactions, managedWallets } from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import { createFakeReceiptTracker, createFakeSigner } from '../support/funding-fakes.js';
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
const WALLET_A = '0x2222222222222222222222222222222222222222';
const WALLET_B = '0x3333333333333333333333333333333333333333';
const WALLET_C = '0x4444444444444444444444444444444444444444';

interface EnsureReadyResponse {
  readonly data: {
    readonly status: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly wallets: readonly {
      readonly walletId: string;
      readonly address: string;
      readonly status: string;
      readonly operationId: string | null;
    }[];
  };
}

describe.skipIf(!integrationEnabled)('POST /v1/environments/:id/ensure-ready (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let signer: TreasurySigner & { readonly sendCalls: number };
  let sendDestinations: string[];
  let sendCallCountByDestination: Map<string, number>;
  let walletBalances: Map<string, bigint>;
  let treasuryBalanceWei: bigint;
  let secondWalletId: string;
  let thirdWalletId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    // Exactly one enabled treasury per chain (TX.5 guard). seedPhase1Fixtures
    // already creates one; do not add another.
    const [secondWallet] = await handle.db
      .insert(managedWallets)
      .values({
        environmentId: seed.environmentId,
        chainId: seed.chainId,
        role: 'relayer',
        address: WALLET_B,
        criticalAtStartup: true,
      })
      .returning({ id: managedWallets.id });
    if (secondWallet === undefined) {
      throw new Error('Failed to seed second managed wallet');
    }
    secondWalletId = secondWallet.id;

    const [thirdWallet] = await handle.db
      .insert(managedWallets)
      .values({
        environmentId: seed.environmentId,
        chainId: seed.chainId,
        role: 'oracle',
        address: WALLET_C,
        criticalAtStartup: false,
      })
      .returning({ id: managedWallets.id });
    if (thirdWallet === undefined) {
      throw new Error('Failed to seed third managed wallet');
    }
    thirdWalletId = thirdWallet.id;

    for (const walletId of [seed.managedWalletId, secondWalletId, thirdWalletId]) {
      await handle.db.insert(fundingPolicies).values({
        managedWalletId: walletId,
        minimumBalanceWei: ONE_ETH.toString(),
        targetBalanceWei: (2n * ONE_ETH).toString(),
        maximumTopUpWei: (5n * ONE_ETH).toString(),
        version: 1,
      });
    }

    const generated = generateApiToken();
    operatorToken = generated.token;
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
    });

    sendDestinations = [];
    sendCallCountByDestination = new Map();
    walletBalances = new Map([
      [WALLET_A.toLowerCase(), ONE_ETH / 10n],
      [WALLET_B.toLowerCase(), ONE_ETH / 10n],
      [WALLET_C.toLowerCase(), ONE_ETH / 10n],
    ]);
    treasuryBalanceWei = 20n * ONE_ETH;

    let sendSeq = 0;
    signer = createFakeSigner({
      send: (input) => {
        sendDestinations.push(input.to);
        const key = input.to.toLowerCase();
        sendCallCountByDestination.set(key, (sendCallCountByDestination.get(key) ?? 0) + 1);
        // Reflect the transfer in the fake balances so a concurrent second
        // request with a different idempotency key observes the funded wallet
        // as at-target (no-op) rather than double-funding after confirmation.
        const prior = walletBalances.get(key) ?? 0n;
        walletBalances.set(key, prior + input.valueWei);
        treasuryBalanceWei -= input.valueWei;
        sendSeq += 1;
        return Promise.resolve({
          transactionHash: `0x${sendSeq.toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
        });
      },
    });

    const balanceReader: BalanceReader = {
      readBalance(address) {
        const normalized = address.toLowerCase();
        const balanceWei =
          normalized === TREASURY_ADDRESS.toLowerCase()
            ? treasuryBalanceWei
            : (walletBalances.get(normalized) ?? 0n);
        return Promise.resolve({
          kind: 'observed',
          balanceWei,
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
        TREASURY_ADDRESS,
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
      },
      balanceReader,
      treasurySigner: signer,
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: new Date('2026-08-01T12:00:01.000Z'),
      }),
      emailSender: {
        send() {
          return Promise.resolve({
            kind: 'sent' as const,
            providerMessageId: `msg-${randomUUID()}`,
          });
        },
      },
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

  it('funds each below-minimum wallet exactly once and replays the same idempotency key', async () => {
    const path = `/v1/environments/${seed.environmentId}/ensure-ready`;
    const body = { idempotencyKey: 'integration-ensure-ready-1' };

    const first = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const firstJson = first.json<EnsureReadyResponse>();
    expect(firstJson.data.status).toBe('ready');
    expect(firstJson.data.wallets).toHaveLength(3);
    expect(firstJson.data.wallets.every((wallet) => wallet.status === 'funded')).toBe(true);
    expect(signer.sendCalls).toBe(3);
    expect(new Set(sendDestinations.map((address) => getAddress(address)))).toEqual(
      new Set([getAddress(WALLET_A), getAddress(WALLET_B), getAddress(WALLET_C)]),
    );

    const second = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    const secondJson = second.json<EnsureReadyResponse>();
    expect(secondJson.data.status).toBe('ready');
    // Replay must not submit additional transfers.
    expect(signer.sendCalls).toBe(3);

    const firstOps = firstJson.data.wallets.map((wallet) => wallet.operationId).sort();
    const secondOps = secondJson.data.wallets.map((wallet) => wallet.operationId).sort();
    expect(secondOps).toEqual(firstOps);

    const txCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM funding_transactions`,
    );
    expect(txCount.rows[0]?.count).toBe('3');
  });

  it('concurrent ensure-ready calls with different keys create exactly one transfer per below-minimum wallet', async () => {
    const path = `/v1/environments/${seed.environmentId}/ensure-ready`;

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { idempotencyKey: 'concurrent-a' },
      }),
      app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { idempotencyKey: 'concurrent-b' },
      }),
    ]);

    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);

    // Acceptance criterion: exactly one transfer per below-minimum wallet.
    expect(signer.sendCalls).toBe(3);
    expect(sendCallCountByDestination.get(WALLET_A.toLowerCase())).toBe(1);
    expect(sendCallCountByDestination.get(WALLET_B.toLowerCase())).toBe(1);
    expect(sendCallCountByDestination.get(WALLET_C.toLowerCase())).toBe(1);

    const submitted = await handle.db.select().from(fundingTransactions);
    expect(submitted).toHaveLength(3);
    const walletIds = new Set(submitted.map((row) => row.managedWalletId));
    expect(walletIds).toEqual(new Set([seed.managedWalletId, secondWalletId, thirdWalletId]));
  });

  it('produces one treasury_reserve alert row for a burst of reserve refusals across N wallets', async () => {
    // Spendable is zero after reserve + gas: every wallet is refused.
    treasuryBalanceWei = ONE_ETH / 10n;
    await app.close();
    app = await buildApp({
      ...container,
      treasurySigner: createFakeSigner({
        estimatedCostWei: ONE_ETH / 100n,
        send: () => {
          throw new Error('signer must not be called when reserve blocks');
        },
      }),
    });
    // Keep the outer signer counter for other tests; this rebuild replaces the app signer.
    const path = `/v1/environments/${seed.environmentId}/ensure-ready`;

    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { idempotencyKey: 'reserve-burst-1' },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json<EnsureReadyResponse>();
    // Second wallet is criticalAtStartup → overall blocked; others warning.
    expect(json.data.status).toBe('blocked');
    expect(json.data.wallets).toHaveLength(3);
    expect(json.data.wallets.every((wallet) => wallet.status === 'warning' || wallet.status === 'blocked')).toBe(
      true,
    );

    const alerts = await handle.pool.query<{ count: string; alert_type: string }>(
      `SELECT count(*)::text AS count, alert_type
       FROM alerts
       WHERE alert_type = $1 AND state = 'open'
       GROUP BY alert_type`,
      [TREASURY_RESERVE_ALERT_TYPE],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]?.count).toBe('1');
  });

  it('rejects unknown fields and never accepts a destination address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/environments/${seed.environmentId}/ensure-ready`,
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
});
