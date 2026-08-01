import { describe, expect, it } from 'vitest';
import { dispatchFunding } from '../../../../src/app/funding/dispatch-funding.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import {
  createFakeBalanceReader,
  createFakeSigner,
  createInMemoryFundingStores,
} from '../../../support/funding-fakes.js';

const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222';
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
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
      address: TREASURY_ADDRESS,
      // Pre-lock observation only; money path uses the in-lock BalanceReader.
      balanceWei: 10n * ONE_ETH,
    },
    walletId: 'wallet-1',
    projectEnabled: true,
    environmentEnabled: true,
    policy: {
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
      isEnabled: true,
    },
    // Pre-lock observation only; money path uses the in-lock BalanceReader.
    walletBalanceWei: ONE_ETH / 10n,
    ...overrides,
  };
}

function createManagedWalletRepo(options?: {
  readonly enabled?: boolean;
  readonly addressDisplay?: string;
  readonly chainId?: number;
  readonly wallets?: Map<string, { enabled: boolean; addressDisplay: string; chainId: number }>;
}) {
  const wallets =
    options?.wallets ??
    new Map([
      [
        'wallet-1',
        {
          enabled: options?.enabled ?? true,
          addressDisplay: options?.addressDisplay ?? WALLET_ADDRESS,
          chainId: options?.chainId ?? 11_155_111,
        },
      ],
    ]);
  return {
    findById(id: string) {
      const row = wallets.get(id);
      if (row === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        id,
        project: { id: 'project-1', slug: 'p', name: 'P', enabled: true },
        environment: { id: 'env-1', projectId: 'project-1', slug: 'e', name: 'E', enabled: true },
        chain: {
          id: 'chain-1',
          slug: 'sepolia',
          chainId: row.chainId,
          displayName: 'Sepolia',
          nativeSymbol: 'ETH',
          explorerBaseUrl: 'https://sepolia.etherscan.io',
        },
        role: 'signer',
        address: row.addressDisplay.toLowerCase(),
        addressDisplay: row.addressDisplay,
        enabled: row.enabled,
        criticalAtStartup: false,
        reconciliationEnabled: false,
        policy: undefined,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    },
    insert: () => Promise.reject(new Error('unused')),
    list: () => Promise.reject(new Error('unused')),
    update: () => Promise.reject(new Error('unused')),
  };
}

function deps(overrides: {
  readonly signer?: ReturnType<typeof createFakeSigner>;
  readonly isFundingEnabled?: boolean;
  readonly isFundingKillSwitchActive?: boolean;
  readonly stores?: ReturnType<typeof createInMemoryFundingStores>;
  readonly lock?: ReturnType<typeof createInMemoryFundingStores>['lock'];
  readonly managedWallets?: ReturnType<typeof createManagedWalletRepo>;
  readonly balanceReader?: ReturnType<typeof createFakeBalanceReader>;
  readonly walletBalanceWei?: bigint;
  readonly treasuryBalanceWei?: bigint;
  readonly walletAddresses?: readonly string[];
}) {
  const stores = overrides.stores ?? createInMemoryFundingStores();
  const clock = createFixedClock();
  let n = 0;
  const signer = overrides.signer ?? createFakeSigner({});
  const walletWei = overrides.walletBalanceWei ?? ONE_ETH / 10n;
  const treasuryWei = overrides.treasuryBalanceWei ?? 10n * ONE_ETH;
  const balanceEntries: Record<string, bigint> = {
    [TREASURY_ADDRESS.toLowerCase()]: treasuryWei,
    [WALLET_ADDRESS.toLowerCase()]: walletWei,
  };
  for (const address of overrides.walletAddresses ?? []) {
    balanceEntries[address.toLowerCase()] = walletWei;
  }
  const balanceReader =
    overrides.balanceReader ??
    createFakeBalanceReader({
      balances: balanceEntries,
    });
  return {
    stores,
    clock,
    signer,
    balanceReader,
    dependencies: {
      operations: stores.operations,
      transactions: stores.transactions,
      managedWallets: overrides.managedWallets ?? createManagedWalletRepo(),
      lock: overrides.lock ?? stores.lock,
      signer,
      balanceReader,
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
    const { dependencies, signer } = deps({
      managedWallets: createManagedWalletRepo({ enabled: false }),
    });
    await expect(dispatchFunding(dependencies, baseInput())).rejects.toMatchObject({
      code: 'ENTITY_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('refuses when the resolved treasury snapshot is disabled', async () => {
    // Defense in depth for a mid-flight disable: dispatch checks the treasury
    // enable flag on the input snapshot before any signer call.
    const { dependencies, signer } = deps({});
    await expect(
      dispatchFunding(
        dependencies,
        baseInput({
          treasury: {
            id: 'treasury-1',
            evmChainId: 11_155_111,
            enabled: false,
            reserveWei: ONE_ETH / 2n,
            address: TREASURY_ADDRESS,
            balanceWei: 10n * ONE_ETH,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ENTITY_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('signs only to the repository address, never a caller-supplied destination', async () => {
    const registered = '0x2222222222222222222222222222222222222222';
    const signer = createFakeSigner({
      send: (input) => {
        expect(input.to).toBe(registered);
        return Promise.resolve({ transactionHash: `0x${'ab'.repeat(32)}` });
      },
    });
    const { dependencies } = deps({
      signer,
      managedWallets: createManagedWalletRepo({ addressDisplay: registered }),
    });
    // DispatchFundingInput has no address field; an arbitrary destination cannot be supplied.
    const result = await dispatchFunding(dependencies, baseInput());
    expect(result.kind).toBe('submitted');
    expect(signer.sendCalls).toBe(1);
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

  it('returns no-op when the in-lock wallet balance is already at or above minimum', async () => {
    const { dependencies, signer } = deps({ walletBalanceWei: ONE_ETH });
    const result = await dispatchFunding(
      dependencies,
      baseInput({ walletBalanceWei: ONE_ETH / 10n, idempotencyKey: 'noop-1' }),
    );
    expect(result.kind).toBe('no-op');
    if (result.kind === 'no-op') {
      expect(result.operation.status).toBe('succeeded');
    }
    expect(signer.sendCalls).toBe(0);
  });

  it('no-ops from a fresh in-lock read even when the stale pre-lock balance was below minimum', async () => {
    // TX.8: the pre-lock observation stays on the input for API/audit, but the
    // money decision must use the lock-time re-read.
    const { dependencies, signer } = deps({ walletBalanceWei: ONE_ETH });
    const result = await dispatchFunding(
      dependencies,
      baseInput({
        walletBalanceWei: ONE_ETH / 10n,
        idempotencyKey: 'stale-below-fresh-above',
      }),
    );
    expect(result.kind).toBe('no-op');
    expect(signer.sendCalls).toBe(0);
  });

  it('funds from the fresh in-lock deficit, not a larger stale pre-lock deficit', async () => {
    // Stale observation: 0.1 ETH → deficit 1.9 ETH. Fresh: 0.5 ETH → deficit 1.5 ETH.
    const freshWalletWei = ONE_ETH / 2n;
    const signer = createFakeSigner({
      send: (input) => {
        expect(input.valueWei).toBe(2n * ONE_ETH - freshWalletWei);
        return Promise.resolve({ transactionHash: `0x${'ab'.repeat(32)}` });
      },
    });
    const { dependencies } = deps({ signer, walletBalanceWei: freshWalletWei });
    const result = await dispatchFunding(
      dependencies,
      baseInput({
        walletBalanceWei: ONE_ETH / 10n,
        idempotencyKey: 'fresh-deficit',
      }),
    );
    expect(result.kind).toBe('submitted');
    if (result.kind === 'submitted') {
      expect(result.transaction.amountWei).toBe(2n * ONE_ETH - freshWalletWei);
    }
    expect(signer.sendCalls).toBe(1);
  });

  it('blocks when reserve would be breached', async () => {
    const { dependencies, signer } = deps({
      signer: createFakeSigner({ estimatedCostWei: 9n * ONE_ETH }),
      treasuryBalanceWei: ONE_ETH + 1000n,
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
          address: TREASURY_ADDRESS,
          // Stale high balance must not override the fresh in-lock read.
          balanceWei: 100n * ONE_ETH,
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

  it('records an ambiguous submission failure as non-terminal submission_unknown', async () => {
    // An RPC timeout can follow a successful broadcast, so the transfer may
    // still mine. Marking it terminal would reopen the duplicate-funding gate.
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
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'submit-ambiguous' })),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });

    const txs = [...stores.txsById.values()];
    expect(txs).toHaveLength(1);
    expect(txs[0]?.status).toBe('submission_unknown');
    expect(txs[0]?.transactionHash).toBeUndefined();
    // Nonce is retained so reconciliation can identify the in-flight transfer.
    expect(txs[0]?.nonce).toBe(7);
  });

  it('keeps the duplicate-funding gate closed after an ambiguous submission', async () => {
    const signer = createFakeSigner({
      send: () => Promise.reject(new ChainBankError('RPC_UNAVAILABLE', 'submit timed out')),
    });
    const { dependencies, stores } = deps({ signer });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'ambiguous-1' })),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });

    // A retry must not create a second transfer while the first may be in flight.
    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'ambiguous-retry' })),
    ).rejects.toMatchObject({ code: 'PENDING_FUNDING_EXISTS' });

    expect([...stores.txsById.values()]).toHaveLength(1);
    expect(signer.sendCalls).toBe(1);
  });

  it('marks the transaction failed when the error proves the transfer never broadcast', async () => {
    const signer = createFakeSigner({
      send: () =>
        Promise.reject(
          new ChainBankError('INVALID_AMOUNT', 'Transfer value must be a non-negative integer wei amount.'),
        ),
    });
    const { dependencies, stores } = deps({ signer });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'submit-rejected' })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    const txs = [...stores.txsById.values()];
    expect(txs).toHaveLength(1);
    expect(txs[0]?.status).toBe('failed');
  });

  it('treats an in-lock balance-read RPC_UNAVAILABLE as terminal pre-broadcast failure', async () => {
    // BalanceReader uses RPC_UNAVAILABLE for read failures; the same code after
    // sendNativeTransfer means submission_unknown. In-lock reads happen before
    // insertCreated, so they must never create a transaction row.
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS.toLowerCase()]: 10n * ONE_ETH,
        [WALLET_ADDRESS.toLowerCase()]: ONE_ETH / 10n,
      },
      unavailable: {
        [WALLET_ADDRESS.toLowerCase()]: 'RPC_UNAVAILABLE',
      },
    });
    const { dependencies, signer, stores } = deps({ balanceReader });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'in-lock-read-fail' })),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });

    expect(signer.sendCalls).toBe(0);
    expect([...stores.txsById.values()]).toHaveLength(0);
    const failedOp = [...stores.opsById.values()].find((op) => op.idempotencyKey === 'in-lock-read-fail');
    expect(failedOp?.status).toBe('failed');
    expect(failedOp?.errorCode).toBe('RPC_UNAVAILABLE');
  });

  it('treats an in-lock treasury balance-read failure as terminal pre-broadcast failure', async () => {
    const balanceReader = createFakeBalanceReader({
      balances: {
        [TREASURY_ADDRESS.toLowerCase()]: 10n * ONE_ETH,
        [WALLET_ADDRESS.toLowerCase()]: ONE_ETH / 10n,
      },
      unavailable: {
        [TREASURY_ADDRESS.toLowerCase()]: 'CHAIN_ID_MISMATCH',
      },
    });
    const { dependencies, signer, stores } = deps({ balanceReader });

    await expect(
      dispatchFunding(dependencies, baseInput({ idempotencyKey: 'in-lock-treasury-fail' })),
    ).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });

    expect(signer.sendCalls).toBe(0);
    expect([...stores.txsById.values()]).toHaveLength(0);
    const failedOp = [...stores.opsById.values()].find((op) => op.idempotencyKey === 'in-lock-treasury-fail');
    expect(failedOp?.status).toBe('failed');
    expect(failedOp?.errorCode).toBe('CHAIN_ID_MISMATCH');
  });

  it('counts in-flight transfers to other wallets against the treasury reserve', async () => {
    const reserveWei = 9n * ONE_ETH;
    const treasury = {
      balanceWei: 10n * ONE_ETH,
      reserveWei,
      address: TREASURY_ADDRESS,
    };
    // Each wallet may draw up to 0.9 ETH; three would breach a 9 ETH reserve
    // on a 10 ETH balance if in-flight amounts were ignored.
    const policy = {
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: (9n * ONE_ETH) / 10n,
      isEnabled: true,
    };
    const wallets = new Map([
      [
        'wallet-a',
        { enabled: true, addressDisplay: '0x000000000000000000000000000000000000000a', chainId: 11_155_111 },
      ],
      [
        'wallet-b',
        { enabled: true, addressDisplay: '0x000000000000000000000000000000000000000b', chainId: 11_155_111 },
      ],
      [
        'wallet-c',
        { enabled: true, addressDisplay: '0x000000000000000000000000000000000000000c', chainId: 11_155_111 },
      ],
    ]);
    const { dependencies, stores } = deps({
      managedWallets: createManagedWalletRepo({ wallets }),
      walletBalanceWei: 0n,
      treasuryBalanceWei: 10n * ONE_ETH,
      walletAddresses: [...wallets.values()].map((w) => w.addressDisplay),
    });
    const walletInput = (id: string, idempotencyKey: string) =>
      baseInput({
        idempotencyKey,
        policy,
        treasury: { ...baseInput().treasury, ...treasury },
        walletId: id,
        walletBalanceWei: 0n,
      });

    const first = await dispatchFunding(dependencies, walletInput('wallet-a', 'reserve-a'));
    expect(first.kind).toBe('submitted');

    // The observed balance still reads 10 ETH because nothing has mined, so
    // only in-flight accounting can bound the second transfer.
    const second = await dispatchFunding(dependencies, walletInput('wallet-b', 'reserve-b'));
    expect(second.kind).toBe('submitted');

    // Spendable is now exhausted, so the third wallet is refused outright.
    const third = await dispatchFunding(dependencies, walletInput('wallet-c', 'reserve-c'));
    expect(third.kind).toBe('blocked');
    if (third.kind === 'blocked') {
      expect(third.reason).toBe('reserve');
    }

    // The invariant: everything in flight together cannot breach the reserve.
    const inFlightWei = [...stores.txsById.values()]
      .filter((tx) => tx.status === 'submitted')
      .reduce((sum, tx) => sum + tx.amountWei, 0n);
    expect(inFlightWei).toBeLessThanOrEqual(10n * ONE_ETH - reserveWei);
  });
});
