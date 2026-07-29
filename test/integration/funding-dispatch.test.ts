import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { dispatchFunding } from '../../src/app/funding/dispatch-funding.js';
import { ensureIdempotentOperation } from '../../src/app/funding/ensure-idempotent-operation.js';
import type { TreasurySigner } from '../../src/app/ports.js';
import { ChainBankError } from '../../src/domain/errors.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { fundingTransactions, managedWallets } from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { createFixedClock } from '../support/clock.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const ONE_ETH = 10n ** 18n;
const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222';

function createControllableSigner(options: {
  readonly onSend?: () => Promise<void>;
  readonly getNonce?: () => number;
}): TreasurySigner & { readonly sendCalls: number; readonly nonces: number[] } {
  const state = { sendCalls: 0, nonces: [] as number[] };
  return {
    get address() {
      return '0x1111111111111111111111111111111111111111';
    },
    get sendCalls() {
      return state.sendCalls;
    },
    get nonces() {
      return state.nonces;
    },
    verifyChainId() {
      return Promise.resolve({ matches: true, observedChainId: 11_155_111 });
    },
    getTransactionCount() {
      return Promise.resolve(options.getNonce?.() ?? state.sendCalls);
    },
    estimateTransferCostWei() {
      return Promise.resolve(21_000n);
    },
    async sendNativeTransfer(input) {
      state.nonces.push(input.nonce);
      if (options.onSend !== undefined) {
        await options.onSend();
      }
      state.sendCalls += 1;
      return { transactionHash: `0x${state.sendCalls.toString(16).padStart(64, '0')}` };
    },
  };
}

describe.skipIf(!integrationEnabled)('Funding dispatch engine (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  function buildDispatch(signer: TreasurySigner, correlationId: string) {
    const clock = createFixedClock();
    return {
      clock,
      dependencies: {
        operations: createFundingOperationRepository(handle.db),
        transactions: createFundingTransactionRepository(handle.db),
        lock: createFundingDispatchLock(handle.db),
        signer,
        clock,
        idGenerator: { next: () => crypto.randomUUID() },
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
        isFundingEnabled: true,
        isFundingKillSwitchActive: false,
      },
      input: {
        operationType: 'ensure_funded',
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        idempotencyKey: undefined as string | undefined,
        requestedBy: 'cred-integration',
        correlationId,
        treasury: {
          id: seed.treasuryId,
          evmChainId: 11_155_111,
          enabled: true,
          reserveWei: ONE_ETH / 2n,
          balanceWei: 20n * ONE_ETH,
        },
        wallet: {
          id: seed.managedWalletId,
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
      },
    };
  }

  it('produces exactly one transaction for two concurrent dispatches to the same wallet', async () => {
    let releaseFirstSend: (() => void) | undefined;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let enteredSend = 0;

    const signer = createControllableSigner({
      onSend: async () => {
        enteredSend += 1;
        if (enteredSend === 1) {
          // Hold the advisory lock while the second dispatcher waits.
          await firstSendGate;
        }
      },
      getNonce: () => enteredSend,
    });

    const first = buildDispatch(signer, 'corr-concurrent-a');
    const second = buildDispatch(signer, 'corr-concurrent-b');
    first.input.idempotencyKey = 'concurrent-a';
    second.input.idempotencyKey = 'concurrent-b';

    const firstPromise = dispatchFunding(first.dependencies, first.input);
    // Allow the first dispatcher to acquire the lock and reach send.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondPromise = dispatchFunding(second.dependencies, second.input);

    releaseFirstSend?.();

    const results = await Promise.allSettled([firstPromise, secondPromise]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0]?.status === 'fulfilled') {
      expect(fulfilled[0].value.kind).toBe('submitted');
    }
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ChainBankError);
      expect((rejected[0].reason as ChainBankError).code).toBe('PENDING_FUNDING_EXISTS');
    }

    const rows = await handle.db.select().from(fundingTransactions);
    const submitted = rows.filter((row) => row.status === 'submitted');
    expect(submitted).toHaveLength(1);
    expect(signer.sendCalls).toBe(1);
  });

  it('replays the same idempotency key against Postgres without a second submit', async () => {
    const signer = createControllableSigner({});
    const ctx = buildDispatch(signer, 'corr-replay');
    ctx.input.idempotencyKey = 'replay-key';

    const first = await dispatchFunding(ctx.dependencies, ctx.input);
    const second = await dispatchFunding(ctx.dependencies, ctx.input);

    expect(first.kind).toBe('submitted');
    expect(second.kind).toBe('replay');
    expect(signer.sendCalls).toBe(1);

    const rows = await handle.db.select().from(fundingTransactions);
    expect(rows).toHaveLength(1);
  });

  it('serializes advisory locks so nonce allocation does not overlap', async () => {
    const order: string[] = [];
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const signer = createControllableSigner({
      onSend: async () => {
        order.push(`send-${String(signer.sendCalls + 1)}`);
        if (signer.sendCalls === 0) {
          await gateA;
        }
      },
      getNonce: () => signer.sendCalls,
    });

    // Second wallet so pending-tx gate does not fire; same treasury lock serializes.
    const [walletB] = await handle.db
      .insert(managedWallets)
      .values({
        environmentId: seed.environmentId,
        chainId: seed.chainId,
        role: 'relayer',
        address: '0x3333333333333333333333333333333333333333',
      })
      .returning();

    if (walletB === undefined) {
      throw new Error('failed to seed second wallet');
    }

    const a = buildDispatch(signer, 'corr-lock-a');
    const b = buildDispatch(signer, 'corr-lock-b');
    a.input.idempotencyKey = 'lock-a';
    b.input.idempotencyKey = 'lock-b';
    b.input.wallet = {
      id: walletB.id,
      address: '0x3333333333333333333333333333333333333333',
      enabled: true,
    };

    const firstPromise = dispatchFunding(a.dependencies, a.input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondPromise = dispatchFunding(b.dependencies, b.input);

    // While A holds the lock inside send, B must not have entered send yet.
    expect(order).toEqual(['send-1']);
    releaseA?.();

    const [resultA, resultB] = await Promise.all([firstPromise, secondPromise]);
    expect(resultA.kind).toBe('submitted');
    expect(resultB.kind).toBe('submitted');
    expect(signer.sendCalls).toBe(2);
    expect(signer.nonces).toEqual([0, 1]);
  });

  it('handles unique-index races by returning the winning operation', async () => {
    const operations = createFundingOperationRepository(handle.db);
    const clock = createFixedClock();
    const key = 'race-key';
    const requestedBy = 'cred-race';

    const [first, second] = await Promise.all([
      ensureIdempotentOperation(
        {
          operations,
          clock,
          idGenerator: { next: () => crypto.randomUUID() },
        },
        {
          operationType: 'ensure_funded',
          projectId: seed.projectId,
          environmentId: seed.environmentId,
          idempotencyKey: key,
          requestedBy,
        },
      ),
      ensureIdempotentOperation(
        {
          operations,
          clock,
          idGenerator: { next: () => crypto.randomUUID() },
        },
        {
          operationType: 'ensure_funded',
          projectId: seed.projectId,
          environmentId: seed.environmentId,
          idempotencyKey: key,
          requestedBy,
        },
      ),
    ]);

    const created = [first, second].filter((r) => r.kind === 'created');
    const replays = [first, second].filter((r) => r.kind === 'replay');
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(1);
    if (created[0] !== undefined && replays[0] !== undefined) {
      expect(replays[0].operation.id).toBe(created[0].operation.id);
    }

    const ops = createFundingOperationRepository(handle.db);
    const found = await ops.findByIdempotencyKey(requestedBy, key);
    expect(found).toBeDefined();
  });

  it('persists submitted hash and never marks confirmed from dispatch alone', async () => {
    const signer = createControllableSigner({});
    const ctx = buildDispatch(signer, 'corr-submit-only');
    ctx.input.idempotencyKey = 'submit-only';

    const result = await dispatchFunding(ctx.dependencies, ctx.input);
    expect(result.kind).toBe('submitted');
    if (result.kind !== 'submitted') {
      return;
    }

    const [row] = await handle.db
      .select()
      .from(fundingTransactions)
      .where(eq(fundingTransactions.id, result.transaction.id));

    expect(row?.status).toBe('submitted');
    expect(row?.transactionHash).toMatch(/^0x/);
    expect(row?.confirmedAt).toBeNull();
    expect(result.operation.status).toBe('in_progress');
  });
});
