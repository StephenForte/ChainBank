import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerFundingOperationRoutes } from '../../../src/api/routes/funding-operations.js';
import { registerErrorHandler } from '../../../src/api/plugins/error-handler.js';
import type { AppInstance } from '../../../src/api/types.js';
import type { Container } from '../../../src/container.js';
import type { Treasury } from '../../../src/app/ports.js';
import { createLogger } from '../../../src/observability/logger.js';
import { createFixedClock } from '../../support/clock.js';
import {
  createFakeBalanceReader,
  createFakeReceiptTracker,
  createInMemoryFundingStores,
  createTestChainAdapterRegistry,
} from '../../support/funding-fakes.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';
const BASE_TREASURY_ID = '33333333-3333-4333-8333-333333333333';
const BASE_CHAIN_ID = 84_532;
const SEPOLIA_TREASURY = `0x${'11'.repeat(20)}`;
const BASE_TREASURY = `0x${'22'.repeat(20)}`;
const HASH = `0x${'ab'.repeat(32)}`;

function baseTreasury(): Treasury {
  return {
    id: BASE_TREASURY_ID,
    chain: {
      id: 'chain-base',
      slug: 'base-sepolia',
      chainId: BASE_CHAIN_ID,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.basescan.org',
    },
    address: BASE_TREASURY.toLowerCase(),
    addressDisplay: BASE_TREASURY,
    kind: 'operational',
    policy: undefined,
    thresholds: {
      warningBalanceWei: 1n,
      criticalBalanceWei: 1n,
      recoveryBalanceWei: 1n,
      minimumReserveWei: 1n,
    },
    status: 'healthy',
    lastObservedBalanceWei: undefined,
    lastObservedAt: undefined,
    lastCheckedAt: undefined,
    lastCheckErrorCode: undefined,
    lastOutgoingScanBlock: undefined,
    lastOutgoingScanAt: undefined,
    lastOutgoingScanNonce: undefined,
    enabled: true,
  };
}

describe('GET /v1/funding-operations/:id chain identity', () => {
  it('reports chain B treasury address, not the default chain treasury', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    await stores.operations.insertPending({
      id: OPERATION_ID,
      operationType: 'ensure_funded',
      projectId: undefined,
      environmentId: undefined,
      idempotencyKey: undefined,
      requestedBy: 'operator',
      startedAt: clock.now(),
    });
    await stores.operations.markInProgress(OPERATION_ID);
    const created = await stores.transactions.insertCreated({
      id: TX_ID,
      operationId: OPERATION_ID,
      treasuryId: BASE_TREASURY_ID,
      managedWalletId: 'wallet-1',
      destinationTreasuryId: undefined,
      amountWei: 10n ** 15n,
      createdAt: clock.now(),
    });
    await stores.transactions.markSubmitted(created.id, {
      transactionHash: HASH,
      nonce: 4,
      submittedAt: clock.now(),
    });

    const receiptTracker = createFakeReceiptTracker({ kind: 'pending' });
    const waitSpy = vi.spyOn(receiptTracker, 'waitForOutcome');
    const treasury = baseTreasury();

    const app = Fastify({
      loggerInstance: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    }) as AppInstance;
    registerErrorHandler(app);
    app.decorate('authenticate', (request, _reply, done) => {
      request.actor = { credentialId: 'cred-1', name: 'op', role: 'operator' };
      done();
    });

    const container = {
      repositories: {
        fundingOperations: stores.operations,
        fundingTransactions: stores.transactions,
        treasuries: {
          findById: vi.fn((id: string) => Promise.resolve(id === BASE_TREASURY_ID ? treasury : undefined)),
        },
        credentialScopes: {
          listByCredentialId: vi.fn(() => Promise.resolve([])),
          insert: vi.fn(),
        },
      },
      chainAdapters: createTestChainAdapterRegistry({
        chainId: BASE_CHAIN_ID,
        balanceReader: createFakeBalanceReader({ chainId: BASE_CHAIN_ID }),
        receiptTracker,
      }),
      clock,
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      config: {
        treasury: { address: SEPOLIA_TREASURY },
        funding: { confirmations: 1, confirmationTimeoutMs: 60_000 },
      },
    } as unknown as Container;

    registerFundingOperationRoutes(app, container);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/funding-operations/${OPERATION_ID}`,
    });

    expect(response.statusCode).toBe(200);
    const body: {
      data: {
        transaction: {
          treasuryAddress: string;
          chain: { chainId: number; displayName: string; slug: string; nativeSymbol: string };
          explorerUrl: string;
        };
      };
    } = response.json();
    expect(body.data.transaction.treasuryAddress).toBe(BASE_TREASURY);
    expect(body.data.transaction.treasuryAddress).not.toBe(SEPOLIA_TREASURY);
    expect(body.data.transaction.chain).toEqual({
      slug: 'base-sepolia',
      chainId: BASE_CHAIN_ID,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
    });
    expect(body.data.transaction.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${HASH}`);
    expect(JSON.stringify(body)).not.toContain(SEPOLIA_TREASURY);
    expect(waitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAddress: BASE_TREASURY,
        transactionHash: HASH,
        nonce: 4,
      }),
    );

    await app.close();
  });
});
