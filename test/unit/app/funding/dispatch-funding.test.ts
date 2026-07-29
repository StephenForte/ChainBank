import { describe, expect, it } from 'vitest';
import { dispatchFunding } from '../../../../src/app/funding/dispatch-funding.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import { createFakeSigner, createInMemoryFundingStores } from '../../../support/funding-fakes.js';

const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222';
const ONE_ETH = 10n ** 18n;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    operationType: 'ensure_funded',
    projectId: 'project-1',
    environmentId: 'env-1',
    idempotencyKey: 'idem-1',
    requestedBy: 'cred-1',
    correlationId: 'corr-1',
    treasury: {
      id: 'treasury-1',
      evmChainId: 11_155_111,
      enabled: true,
      reserveWei: ONE_ETH / 2n,
      balanceWei: 10n * ONE_ETH,
    },
    wallet: {
      id: 'wallet-1',
      address: WALLET_ADDRESS,
      enabled: true,
    },
    projectEnabled: true,
    environmentEnabled: true,
    policy: {
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
      isEnabled: true,
    },
    walletBalanceWei: ONE_ETH / 10n,
    ...overrides,
  };
}

function deps(overrides: {
  readonly signer?: ReturnType<typeof createFakeSigner>;
  readonly isFundingEnabled?: boolean;
  readonly isFundingKillSwitchActive?: boolean;
  readonly stores?: ReturnType<typeof createInMemoryFundingStores>;
  readonly lock?: ReturnType<typeof createInMemoryFundingStores>['lock'];
}) {
  const stores = overrides.stores ?? createInMemoryFundingStores();
  const clock = createFixedClock();
  let n = 0;
  const signer = overrides.signer ?? createFakeSigner({});
  return {
    stores,
    clock,
    signer,
    dependencies: {
      operations: stores.operations,
      transactions: stores.transactions,
      lock: overrides.lock ?? stores.lock,
      signer,
      clock,
      idGenerator: { next: () => `id-${String(++n)}` },
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      isFundingEnabled: overrides.isFundingEnabled ?? true,
      isFundingKillSwitchActive: overrides.isFundingKillSwitchActive ?? false,
    },
  };
}

describe('dispatchFunding', () => {
  it('refuses when FUNDING_ENABLED is false without calling the signer', async () => {
    const { dependencies, signer } = deps({ isFundingEnabled: false });
    await expect(dispatchFunding(dependencies, baseInput())).rejects.toMatchObject({
      code: 'FUNDING_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('refuses when FUNDING_KILL_SWITCH is active', async () => {
    const { dependencies, signer } = deps({ isFundingKillSwitchActive: true });
    await expect(dispatchFunding(dependencies, baseInput())).rejects.toMatchObject({
      code: 'FUNDING_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('refuses when a managed wallet is disabled', async () => {
    const { dependencies, signer } = deps({});
    await expect(
      dispatchFunding(
        dependencies,
        baseInput({ wallet: { id: 'wallet-1', address: WALLET_ADDRESS, enabled: false } }),
      ),
    ).rejects.toMatchObject({ code: 'ENTITY_DISABLED' });
    expect(signer.sendCalls).toBe(0);
  });

  it('submits a transfer after re-checking policy and persists the hash as submitted', async () => {
    const { dependencies, signer, stores } = deps({});
    const result = await dispatchFunding(dependencies, baseInput());

    expect(result.kind).toBe('submitted');
    if (result.kind !== 'submitted') {
      return;
    }
    expect(result.operation.status).toBe('in_progress');
    expect(result.transaction.status).toBe('submitted');
    expect(result.transaction.transactionHash).toMatch(/^0x/);
    expect(result.transaction.nonce).toBe(7);
    expect(signer.sendCalls).toBe(1);
    expect(stores.txsById.size).toBe(1);
  });

  it('replays the same idempotency key without a second transfer', async () => {
    const { dependencies, signer } = deps({});
    const first = await dispatchFunding(dependencies, baseInput());
    const second = await dispatchFunding(dependencies, baseInput());

    expect(first.kind).toBe('submitted');
    expect(second.kind).toBe('replay');
    if (first.kind === 'submitted' && second.kind === 'replay') {
      expect(second.operation.id).toBe(first.operation.id);
      expect(second.transaction?.id).toBe(first.transaction.id);
    }
    expect(signer.sendCalls).toBe(1);
  });

  it('returns no-op when the wallet is already at or above minimum', async () => {
    const { dependencies, signer } = deps({});
    const result = await dispatchFunding(
      dependencies,
      baseInput({ walletBalanceWei: ONE_ETH, idempotencyKey: 'noop-1' }),
    );
    expect(result.kind).toBe('no-op');
    if (result.kind === 'no-op') {
      expect(result.operation.status).toBe('succeeded');
    }
    expect(signer.sendCalls).toBe(0);
  });

  it('blocks when reserve would be breached', async () => {
    const { dependencies, signer } = deps({
      signer: createFakeSigner({ estimatedCostWei: 9n * ONE_ETH }),
    });
    const result = await dispatchFunding(
      dependencies,
      baseInput({
        idempotencyKey: 'reserve-1',
        treasury: {
          id: 'treasury-1',
          evmChainId: 11_155_111,
          enabled: true,
          reserveWei: ONE_ETH,
          balanceWei: ONE_ETH + 1000n,
        },
      }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toBe('reserve');
      expect(result.operation.status).toBe('failed');
      expect(result.operation.errorCode).toBe('FUNDING_BLOCKED_RESERVE');
    }
    expect(signer.sendCalls).toBe(0);
  });

  it('aborts with conflict when a pending funding transaction already exists', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    await stores.operations.insertPending({
      id: 'prior-op',
      operationType: 'ensure_funded',
      projectId: 'project-1',
      environmentId: 'env-1',
      idempotencyKey: undefined,
      requestedBy: 'other',
      startedAt: clock.now(),
    });
    await stores.transactions.insertCreated({
      id: 'prior-tx',
      operationId: 'prior-op',
      treasuryId: 'treasury-1',
      managedWalletId: 'wallet-1',
      amountWei: ONE_ETH,
      createdAt: clock.now(),
    });
    await stores.transactions.markSubmitted('prior-tx', {
      transactionHash: `0x${'cd'.repeat(32)}`,
      nonce: 1,
      submittedAt: clock.now(),
    });

    const { dependencies, signer } = deps({ stores });
    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'conflict-1' })),
    ).rejects.toMatchObject({ code: 'PENDING_FUNDING_EXISTS' });
    expect(signer.sendCalls).toBe(0);

    const failedOp = [...stores.opsById.values()].find((op) => op.idempotencyKey === 'conflict-1');
    expect(failedOp?.status).toBe('failed');
    expect(failedOp?.errorCode).toBe('PENDING_FUNDING_EXISTS');
  });

  it('refuses to sign when the RPC chain ID does not match', async () => {
    const { dependencies, signer } = deps({
      signer: createFakeSigner({ chainMatches: false }),
    });
    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'chain-1' })),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' });
    expect(signer.sendCalls).toBe(0);
  });

  it('does not call sendNativeTransfer when the database lock fails', async () => {
    const signer = createFakeSigner({});
    const { dependencies } = deps({
      signer,
      lock: {
        runExclusive: () => Promise.reject(new ChainBankError('DATABASE_UNAVAILABLE', 'lock failed')),
      },
    });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'db-down' })),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(signer.sendCalls).toBe(0);
  });

  it('marks the transaction failed when submission throws, without confirming', async () => {
    const signer = createFakeSigner({
      send: () =>
        Promise.reject(
          new ChainBankError('RPC_UNAVAILABLE', 'submit failed', {
            publicMessage: 'The transfer could not be submitted.',
          }),
        ),
    });
    const { dependencies, stores } = deps({ signer });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'submit-fail' })),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });

    const txs = [...stores.txsById.values()];
    expect(txs).toHaveLength(1);
    expect(txs[0]?.status).toBe('failed');
    expect(txs[0]?.transactionHash).toBeUndefined();
  });
});
