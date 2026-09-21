import { describe, expect, it, vi } from 'vitest';
import { ensureOperationalTreasuryFunded } from '../../../../src/app/funding/ensure-operational-treasury-funded.js';
import { replenishOperationalPrelude } from '../../../../src/app/funding/replenish-operational-prelude.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  ManagedWalletRepository,
  Treasury,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
import type { ChainBankError } from '../../../../src/domain/errors.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import {
  createFakeReceiptTracker,
  createFakeSigner,
  createInMemoryFundingStores,
  createTestChainAdapterRegistry,
} from '../../../support/funding-fakes.js';

const ONE_ETH = 10n ** 18n;
const now = new Date('2026-08-27T12:00:00.000Z');
const EXTERNAL_ADDRESS = '0x1111111111111111111111111111111111111111';
const OPERATIONAL_ADDRESS = '0x3333333333333333333333333333333333333333';

function buildTreasury(overrides: Partial<Treasury> = {}): Treasury {
  return {
    id: 'treasury-external',
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    address: EXTERNAL_ADDRESS.toLowerCase(),
    addressDisplay: EXTERNAL_ADDRESS,
    kind: 'external',
    policy: undefined,
    thresholds: {
      warningBalanceWei: (ONE_ETH * 75n) / 100n,
      criticalBalanceWei: (ONE_ETH * 3n) / 10n,
      recoveryBalanceWei: (ONE_ETH * 15n) / 10n,
      minimumReserveWei: ONE_ETH / 10n,
    },
    status: 'healthy',
    lastObservedBalanceWei: 20n * ONE_ETH,
    lastObservedAt: now,
    lastCheckedAt: now,
    lastCheckErrorCode: undefined,
    lastOutgoingScanBlock: undefined,
    lastOutgoingScanAt: undefined,
    lastOutgoingScanNonce: undefined,
    enabled: true,
    ...overrides,
  };
}

function operationalTreasury(): Treasury {
  return buildTreasury({
    id: 'treasury-operational',
    address: OPERATIONAL_ADDRESS.toLowerCase(),
    addressDisplay: OPERATIONAL_ADDRESS,
    kind: 'operational',
    policy: {
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
    },
  });
}

function buildDeps(options?: {
  readonly external?: Treasury;
  readonly operational?: Treasury;
  readonly operationalBalanceWei?: bigint;
  readonly externalBalanceWei?: bigint;
  readonly externalSigner?: ReturnType<typeof createFakeSigner> | undefined;
}) {
  const external = options?.external ?? buildTreasury();
  const operational = options?.operational ?? operationalTreasury();
  const stores = createInMemoryFundingStores();
  const signer =
    options && 'externalSigner' in options
      ? options.externalSigner
      : createFakeSigner({ address: external.addressDisplay });

  const balances: Record<string, bigint> = {
    [external.address.toLowerCase()]: options?.externalBalanceWei ?? 20n * ONE_ETH,
    [operational.address.toLowerCase()]: options?.operationalBalanceWei ?? ONE_ETH / 10n,
  };

  const treasuries: TreasuryRepository = {
    listEnabled: vi.fn(() => Promise.resolve([external, operational].filter((row) => row.enabled))),
    findById: vi.fn((id: string) => Promise.resolve([external, operational].find((row) => row.id === id))),
    upsert: vi.fn(),
    setEnabled: vi.fn(),
    recordCheckSuccess: vi.fn(),
    recordCheckFailure: vi.fn(),
    recordOutgoingScanComplete: vi.fn(),
  };

  const destinations: string[] = [];
  const signerWithCapture =
    signer === undefined
      ? undefined
      : createFakeSigner({
          address: signer.address,
          send: (input) => {
            destinations.push(input.to);
            return Promise.resolve({ transactionHash: `0x${'ab'.repeat(32)}` });
          },
        });

  return {
    destinations,
    signer: signerWithCapture,
    stores,
    dependencies: {
      treasuries,
      balanceObservations: {
        record: vi.fn(() => Promise.resolve()),
        findLatest: vi.fn(),
      } satisfies BalanceObservationRepository,
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader: {
          chainId: 11_155_111,
          readBalance(request) {
            const balanceWei = balances[request.address.toLowerCase()];
            if (balanceWei === undefined) {
              return Promise.resolve({
                kind: 'unavailable' as const,
                errorCode: 'RPC_UNAVAILABLE' as const,
                reason: 'missing fixture balance',
                observedAt: now,
              });
            }
            return Promise.resolve({
              kind: 'observed' as const,
              balanceWei,
              blockNumber: 1n,
              observedAt: now,
            });
          },
          verifyChainId: vi.fn(() => Promise.resolve({ matches: true, observedChainId: 11_155_111 })),
        },
        receiptTracker: createFakeReceiptTracker({ kind: 'confirmed', confirmedAt: now }),
        ...(signerWithCapture === undefined ? {} : { externalSigner: signerWithCapture }),
      }),
      auditEvents: { record: vi.fn(() => Promise.resolve()) } satisfies AuditEventRepository,
      alerts: {
        findOpenByEntity: vi.fn(),
        findOpenOrAcknowledgedByEntity: vi.fn(),
        findById: vi.fn(),
        list: vi.fn(),
        insertOpen: vi.fn(),
        markEscalated: vi.fn(),
        markPendingEmail: vi.fn(),
        clearPendingEmail: vi.fn(),
        acknowledgeSend: vi.fn(),
        recordOperatorAcknowledgement: vi.fn(),
        resolve: vi.fn(),
        touchLastEvaluated: vi.fn(),
      } as unknown as AlertRepository,
      emailSender: undefined,
      operations: stores.operations,
      transactions: stores.transactions,
      managedWallets: {
        findById: vi.fn(),
        insert: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
      } satisfies ManagedWalletRepository,
      lock: stores.lock,
      clock: createFixedClock(now),
      idGenerator: (() => {
        let n = 0;
        return { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
      })(),
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      isFundingEnabled: true,
      isFundingKillSwitchActive: false,
      confirmations: 1,
      confirmationTimeoutMs: 1_000,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
    },
    input: {
      operationalTreasuryId: operational.id,
      idempotencyKey: 'replenish-1',
      role: 'operator' as const,
      credentialId: 'cred-operator',
      correlationId: 'corr-1',
      sourceIp: '127.0.0.1',
    },
  };
}

describe('ensureOperationalTreasuryFunded', () => {
  it('refuses when the requested treasury is not operational', async () => {
    const { dependencies } = buildDeps();
    await expect(
      ensureOperationalTreasuryFunded(dependencies, {
        operationalTreasuryId: 'treasury-external',
        idempotencyKey: 'replenish-1',
        role: 'operator',
        credentialId: 'cred-operator',
        correlationId: 'corr-1',
        sourceIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' } satisfies Partial<ChainBankError>);
  });

  it('no-ops when the Private treasury is already at or above minimum', async () => {
    const { dependencies, destinations } = buildDeps({ operationalBalanceWei: 2n * ONE_ETH });
    const result = await ensureOperationalTreasuryFunded(dependencies, {
      operationalTreasuryId: 'treasury-operational',
      idempotencyKey: 'replenish-1',
      role: 'operator',
      credentialId: 'cred-operator',
      correlationId: 'corr-1',
      sourceIp: '127.0.0.1',
    });
    expect(result.status).toBe('no-op');
    expect(destinations).toEqual([]);
  });

  it('sends only to the configured operational address (C24)', async () => {
    const { dependencies, destinations, stores } = buildDeps();
    const result = await ensureOperationalTreasuryFunded(dependencies, {
      operationalTreasuryId: 'treasury-operational',
      idempotencyKey: 'replenish-1',
      role: 'operator',
      credentialId: 'cred-operator',
      correlationId: 'corr-1',
      sourceIp: '127.0.0.1',
    });

    expect(result.status).toBe('funded');
    expect(result.sourceTreasuryId).toBe('treasury-external');
    expect(result.destinationTreasuryId).toBe('treasury-operational');
    expect(destinations).toEqual([OPERATIONAL_ADDRESS]);
    const tx = [...stores.txsById.values()][0];
    expect(tx?.managedWalletId).toBeUndefined();
    expect(tx?.destinationTreasuryId).toBe('treasury-operational');
  });

  it('refuses when the Public signer is missing', async () => {
    const { dependencies } = buildDeps({ externalSigner: undefined });
    await expect(
      ensureOperationalTreasuryFunded(dependencies, {
        operationalTreasuryId: 'treasury-operational',
        idempotencyKey: 'replenish-1',
        role: 'operator',
        credentialId: 'cred-operator',
        correlationId: 'corr-1',
        sourceIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' } satisfies Partial<ChainBankError>);
  });
});

describe('replenishOperationalPrelude', () => {
  it('swallows PENDING_FUNDING_EXISTS so wallet funding can continue', async () => {
    const { dependencies } = buildDeps();
    await dependencies.operations.insertPending({
      id: 'prior-replenish-op',
      operationType: 'replenish_operational',
      projectId: undefined,
      environmentId: undefined,
      idempotencyKey: undefined,
      requestedBy: 'other',
      startedAt: now,
    });
    await dependencies.transactions.insertCreated({
      id: 'prior-replenish-tx',
      operationId: 'prior-replenish-op',
      treasuryId: 'treasury-external',
      managedWalletId: undefined,
      destinationTreasuryId: 'treasury-operational',
      amountWei: ONE_ETH,
      createdAt: now,
    });
    await dependencies.transactions.markSubmitted('prior-replenish-tx', {
      transactionHash: `0x${'cd'.repeat(32)}`,
      nonce: 1,
      submittedAt: now,
    });

    await expect(
      replenishOperationalPrelude(dependencies, {
        evmChainId: 11_155_111,
        role: 'operator',
        credentialId: 'cred-operator',
        correlationId: 'corr-prelude',
        sourceIp: '127.0.0.1',
        idempotencyKey: 'ensure-ready:wallet-1:idem-1',
      }),
    ).resolves.toBeUndefined();
  });
});
