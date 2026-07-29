import { describe, expect, it } from 'vitest';
import { trackTransaction } from '../../../../src/app/funding/track-transaction.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import { createFakeReceiptTracker, createInMemoryFundingStores } from '../../../support/funding-fakes.js';

const HASH = `0x${'ab'.repeat(32)}`;
const SENDER = `0x${'11'.repeat(20)}`;

async function seedSubmitted(txId = 'tx-1', opId = 'op-1') {
  const stores = createInMemoryFundingStores();
  const clock = createFixedClock();
  const operation = await stores.operations.insertPending({
    id: opId,
    operationType: 'ensure_funded',
    projectId: undefined,
    environmentId: undefined,
    idempotencyKey: undefined,
    requestedBy: 'cred-1',
    startedAt: clock.now(),
  });
  await stores.operations.markInProgress(operation.id);
  const created = await stores.transactions.insertCreated({
    id: txId,
    operationId: operation.id,
    treasuryId: 'treasury-1',
    managedWalletId: 'wallet-1',
    amountWei: 10n ** 18n,
    createdAt: clock.now(),
  });
  await stores.transactions.markSubmitted(created.id, {
    transactionHash: HASH,
    nonce: 3,
    submittedAt: clock.now(),
  });
  return { stores, clock };
}

function trackDeps(
  stores: ReturnType<typeof createInMemoryFundingStores>,
  clock: ReturnType<typeof createFixedClock>,
  outcome: Parameters<typeof createFakeReceiptTracker>[0],
) {
  return {
    operations: stores.operations,
    transactions: stores.transactions,
    receiptTracker: createFakeReceiptTracker(outcome),
    clock,
    logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    confirmations: 1,
    confirmationTimeoutMs: 60_000,
  };
}

describe('trackTransaction', () => {
  it('maps a successful receipt to confirmed and succeeds the operation', async () => {
    const { stores, clock } = await seedSubmitted();
    const confirmedAt = new Date('2026-07-26T12:01:00.000Z');
    clock.set(confirmedAt);

    const result = await trackTransaction(trackDeps(stores, clock, { kind: 'confirmed', confirmedAt }), {
      transactionId: 'tx-1',
      correlationId: 'corr-1',
      senderAddress: SENDER,
    });

    expect(result.kind).toBe('confirmed');
    if (result.kind === 'confirmed') {
      expect(result.transaction.status).toBe('confirmed');
      expect(result.operation.status).toBe('succeeded');
      expect(result.transaction.confirmedAt).toEqual(confirmedAt);
    }
  });

  it('maps reverted explicitly', async () => {
    const { stores, clock } = await seedSubmitted('tx-r', 'op-r');
    const result = await trackTransaction(trackDeps(stores, clock, { kind: 'reverted' }), {
      transactionId: 'tx-r',
      correlationId: 'corr-r',
      senderAddress: SENDER,
    });
    expect(result.kind).toBe('reverted');
    if (result.kind === 'reverted') {
      expect(result.transaction.status).toBe('reverted');
      expect(result.operation.status).toBe('failed');
    }
  });

  it('maps replaced explicitly', async () => {
    const { stores, clock } = await seedSubmitted('tx-p', 'op-p');
    const result = await trackTransaction(trackDeps(stores, clock, { kind: 'replaced' }), {
      transactionId: 'tx-p',
      correlationId: 'corr-p',
      senderAddress: SENDER,
    });
    expect(result.kind).toBe('replaced');
    if (result.kind === 'replaced') {
      expect(result.transaction.status).toBe('replaced');
    }
  });

  it('maps dropped explicitly', async () => {
    const { stores, clock } = await seedSubmitted('tx-d', 'op-d');
    const result = await trackTransaction(trackDeps(stores, clock, { kind: 'dropped' }), {
      transactionId: 'tx-d',
      correlationId: 'corr-d',
      senderAddress: SENDER,
    });
    expect(result.kind).toBe('dropped');
    if (result.kind === 'dropped') {
      expect(result.transaction.status).toBe('dropped');
    }
  });

  it('leaves statuses unchanged on confirmation timeout (pending)', async () => {
    const { stores, clock } = await seedSubmitted();
    const result = await trackTransaction(trackDeps(stores, clock, { kind: 'pending' }), {
      transactionId: 'tx-1',
      correlationId: 'corr-timeout',
      senderAddress: SENDER,
    });

    expect(result.kind).toBe('pending');
    if (result.kind === 'pending') {
      expect(result.transaction.status).toBe('submitted');
      expect(result.operation.status).toBe('in_progress');
    }
  });
});
