import { describe, expect, it, vi } from 'vitest';
import {
  getOperationStatus,
  type GetOperationStatusDependencies,
} from '../../../../src/app/funding/get-operation-status.js';
import type { CredentialScope, CredentialScopeRepository } from '../../../../src/app/ports.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import { createFakeReceiptTracker, createInMemoryFundingStores } from '../../../support/funding-fakes.js';

const HASH = `0x${'ab'.repeat(32)}`;
const SENDER = `0x${'11'.repeat(20)}`;
const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

async function seedOperation(options?: {
  readonly opId?: string;
  readonly projectId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly markInProgress?: boolean;
}) {
  const stores = createInMemoryFundingStores();
  const clock = createFixedClock();
  const opId = options?.opId ?? 'op-1';
  const operation = await stores.operations.insertPending({
    id: opId,
    operationType: 'ensure_funded',
    projectId: options?.projectId,
    environmentId: options?.environmentId,
    idempotencyKey: undefined,
    requestedBy: CREDENTIAL_ID,
    startedAt: clock.now(),
  });
  if (options?.markInProgress !== false) {
    await stores.operations.markInProgress(operation.id);
  }
  return { stores, clock, operation };
}

async function seedSubmitted(options?: {
  readonly opId?: string;
  readonly txId?: string;
  readonly projectId?: string;
}) {
  const { stores, clock, operation } = await seedOperation({
    ...(options?.opId !== undefined ? { opId: options.opId } : {}),
    projectId: options?.projectId ?? PROJECT_A,
  });
  const txId = options?.txId ?? 'tx-1';
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
  return { stores, clock, operation };
}

function scopeRepo(scopes: readonly CredentialScope[]): CredentialScopeRepository {
  return {
    listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
    insert: vi.fn(),
  };
}

function deps(
  stores: ReturnType<typeof createInMemoryFundingStores>,
  clock: ReturnType<typeof createFixedClock>,
  outcome: Parameters<typeof createFakeReceiptTracker>[0],
  scopes: readonly CredentialScope[] = [],
): GetOperationStatusDependencies {
  return {
    operations: stores.operations,
    transactions: stores.transactions,
    receiptTracker: createFakeReceiptTracker(outcome),
    credentialScopes: scopeRepo(scopes),
    clock,
    logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    confirmations: 1,
    confirmationTimeoutMs: 60_000,
    treasuryAddress: SENDER,
  };
}

describe('getOperationStatus', () => {
  it('resumes tracking on submitted and maps confirmation timeout to pending', async () => {
    const { stores, clock } = await seedSubmitted();
    const result = await getOperationStatus(deps(stores, clock, { kind: 'pending' }), {
      operationId: 'op-1',
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-timeout',
    });

    expect(result.status).toBe('pending');
    expect(result.reason).toBeUndefined();
    expect(result.transaction?.status).toBe('submitted');
    expect(result.operation.status).toBe('in_progress');
  });

  it('maps confirmed receipt to succeeded', async () => {
    const { stores, clock } = await seedSubmitted();
    const confirmedAt = new Date('2026-07-26T12:01:00.000Z');
    clock.set(confirmedAt);

    const result = await getOperationStatus(deps(stores, clock, { kind: 'confirmed', confirmedAt }), {
      operationId: 'op-1',
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-ok',
    });

    expect(result.status).toBe('succeeded');
    expect(result.operation.status).toBe('succeeded');
    expect(result.transaction?.status).toBe('confirmed');
    expect(result.operation.errorCode).toBeUndefined();
  });

  it('surfaces reverted as a distinct status with TRANSACTION_REVERTED', async () => {
    const { stores, clock } = await seedSubmitted({ opId: 'op-r', txId: 'tx-r' });
    const result = await getOperationStatus(deps(stores, clock, { kind: 'reverted' }), {
      operationId: 'op-r',
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-r',
    });

    expect(result.status).toBe('reverted');
    expect(result.status).not.toBe('failed');
    expect(result.operation.errorCode).toBe('TRANSACTION_REVERTED');
    expect(result.transaction?.status).toBe('reverted');
  });

  it('surfaces replaced as a distinct status with TRANSACTION_REPLACED', async () => {
    const { stores, clock } = await seedSubmitted({ opId: 'op-p', txId: 'tx-p' });
    const result = await getOperationStatus(deps(stores, clock, { kind: 'replaced' }), {
      operationId: 'op-p',
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-p',
    });

    expect(result.status).toBe('replaced');
    expect(result.status).not.toBe('failed');
    expect(result.operation.errorCode).toBe('TRANSACTION_REPLACED');
    expect(result.transaction?.status).toBe('replaced');
  });

  it('surfaces dropped as a distinct status with TRANSACTION_DROPPED', async () => {
    const { stores, clock } = await seedSubmitted({ opId: 'op-d', txId: 'tx-d' });
    const result = await getOperationStatus(deps(stores, clock, { kind: 'dropped' }), {
      operationId: 'op-d',
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-d',
    });

    expect(result.status).toBe('dropped');
    expect(result.operation.errorCode).toBe('TRANSACTION_DROPPED');
    expect(result.transaction?.status).toBe('dropped');
  });

  it('surfaces submission_unknown as pending with reason submission-unconfirmed without tracking', async () => {
    const { stores, clock, operation } = await seedOperation({ projectId: PROJECT_A });
    const created = await stores.transactions.insertCreated({
      id: 'tx-unknown',
      operationId: operation.id,
      treasuryId: 'treasury-1',
      managedWalletId: 'wallet-1',
      amountWei: 5n * 10n ** 17n,
      createdAt: clock.now(),
    });
    await stores.transactions.markSubmissionUnknown(created.id, {
      nonce: 9,
      errorCode: 'RPC_UNAVAILABLE',
    });

    const receiptTracker = createFakeReceiptTracker({ kind: 'confirmed', confirmedAt: clock.now() });
    const waitSpy = vi.spyOn(receiptTracker, 'waitForOutcome');

    const result = await getOperationStatus(
      {
        ...deps(stores, clock, { kind: 'pending' }),
        receiptTracker,
      },
      {
        operationId: operation.id,
        role: 'operator',
        credentialId: CREDENTIAL_ID,
        correlationId: 'corr-unknown',
      },
    );

    expect(result.status).toBe('pending');
    expect(result.reason).toBe('submission-unconfirmed');
    expect(result.transaction?.status).toBe('submission_unknown');
    expect(result.transaction?.transactionHash).toBeUndefined();
    expect(waitSpy).not.toHaveBeenCalled();
  });

  it('returns already-terminal reverted without calling the receipt tracker', async () => {
    const { stores, clock } = await seedSubmitted({ opId: 'op-term', txId: 'tx-term' });
    await stores.transactions.markReverted('tx-term', 'TRANSACTION_REVERTED');
    await stores.operations.markFailed(
      'op-term',
      'TRANSACTION_REVERTED',
      'On-chain transaction reverted.',
      clock.now(),
    );

    const receiptTracker = createFakeReceiptTracker({ kind: 'pending' });
    const waitSpy = vi.spyOn(receiptTracker, 'waitForOutcome');

    const result = await getOperationStatus(
      {
        ...deps(stores, clock, { kind: 'pending' }),
        receiptTracker,
      },
      {
        operationId: 'op-term',
        role: 'read-only',
        credentialId: CREDENTIAL_ID,
        correlationId: 'corr-term',
      },
    );

    expect(result.status).toBe('reverted');
    expect(result.operation.errorCode).toBe('TRANSACTION_REVERTED');
    expect(waitSpy).not.toHaveBeenCalled();
  });

  it('throws FUNDING_OPERATION_NOT_FOUND for unknown ids', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    await expect(
      getOperationStatus(deps(stores, clock, { kind: 'pending' }), {
        operationId: 'missing',
        role: 'operator',
        credentialId: CREDENTIAL_ID,
        correlationId: 'corr-missing',
      }),
    ).rejects.toMatchObject({ code: 'FUNDING_OPERATION_NOT_FOUND' });
  });

  describe('authorization matrix', () => {
    it('allows operator and read-only for any operation including null projectId', async () => {
      const { stores, clock, operation } = await seedOperation({ projectId: undefined });
      for (const role of ['operator', 'read-only'] as const) {
        const result = await getOperationStatus(deps(stores, clock, { kind: 'pending' }), {
          operationId: operation.id,
          role,
          credentialId: CREDENTIAL_ID,
          correlationId: `corr-${role}`,
        });
        expect(result.operation.id).toBe(operation.id);
        expect(result.status).toBe('in_progress');
      }
    });

    it('allows project-service when projectId is in scope', async () => {
      const { stores, clock, operation } = await seedOperation({ projectId: PROJECT_A });
      const scopes: CredentialScope[] = [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: new Date(),
        },
      ];
      const result = await getOperationStatus(deps(stores, clock, { kind: 'pending' }, scopes), {
        operationId: operation.id,
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        correlationId: 'corr-scoped',
      });
      expect(result.operation.id).toBe(operation.id);
    });

    it('denies project-service when projectId is outside scope', async () => {
      const { stores, clock, operation } = await seedOperation({ projectId: PROJECT_B });
      const scopes: CredentialScope[] = [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: new Date(),
        },
      ];
      await expect(
        getOperationStatus(deps(stores, clock, { kind: 'pending' }, scopes), {
          operationId: operation.id,
          role: 'project-service',
          credentialId: CREDENTIAL_ID,
          correlationId: 'corr-denied',
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    });

    it('denies project-service when operation projectId is null', async () => {
      const { stores, clock, operation } = await seedOperation({ projectId: undefined });
      const scopes: CredentialScope[] = [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: new Date(),
        },
      ];
      await expect(
        getOperationStatus(deps(stores, clock, { kind: 'pending' }, scopes), {
          operationId: operation.id,
          role: 'project-service',
          credentialId: CREDENTIAL_ID,
          correlationId: 'corr-null-project',
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    });

    it('denies cron roles', async () => {
      const { stores, clock, operation } = await seedOperation({ projectId: PROJECT_A });
      for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
        await expect(
          getOperationStatus(deps(stores, clock, { kind: 'pending' }), {
            operationId: operation.id,
            role,
            credentialId: CREDENTIAL_ID,
            correlationId: `corr-${role}`,
          }),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      }
    });
  });

  it('passes the configured treasury address as senderAddress when resuming', async () => {
    const { stores, clock } = await seedSubmitted();
    const receiptTracker = createFakeReceiptTracker({ kind: 'pending' });
    const waitSpy = vi.spyOn(receiptTracker, 'waitForOutcome');

    await getOperationStatus(
      {
        ...deps(stores, clock, { kind: 'pending' }),
        receiptTracker,
        treasuryAddress: SENDER,
      },
      {
        operationId: 'op-1',
        role: 'operator',
        credentialId: CREDENTIAL_ID,
        correlationId: 'corr-sender',
      },
    );

    expect(waitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAddress: SENDER,
        transactionHash: HASH,
        nonce: 3,
      }),
    );
  });
});
