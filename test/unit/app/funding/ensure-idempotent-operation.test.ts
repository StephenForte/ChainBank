import { describe, expect, it } from 'vitest';
import { ensureIdempotentOperation } from '../../../../src/app/funding/ensure-idempotent-operation.js';
import type { FundingOperationRepository } from '../../../../src/app/ports.js';
import { createFixedClock } from '../../../support/clock.js';
import { createInMemoryFundingStores, UniqueViolationError } from '../../../support/funding-fakes.js';

describe('ensureIdempotentOperation', () => {
  it('creates a pending operation when no idempotency key is present', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    let n = 0;

    const result = await ensureIdempotentOperation(
      {
        operations: stores.operations,
        clock,
        idGenerator: { next: () => `op-${String(++n)}` },
      },
      {
        operationType: 'ensure_funded',
        projectId: undefined,
        environmentId: undefined,
        idempotencyKey: undefined,
        requestedBy: 'cred-1',
      },
    );

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') {
      return;
    }
    expect(result.operation.status).toBe('pending');
    expect(result.operation.id).toBe('op-1');
  });

  it('replays an existing operation for the same requestedBy + key', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    let n = 0;
    const deps = {
      operations: stores.operations,
      clock,
      idGenerator: { next: () => `op-${String(++n)}` },
    };
    const input = {
      operationType: 'ensure_funded',
      projectId: 'proj',
      environmentId: 'env',
      idempotencyKey: 'key-1',
      requestedBy: 'cred-1',
    };

    const first = await ensureIdempotentOperation(deps, input);
    const second = await ensureIdempotentOperation(deps, input);

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('replay');
    if (first.kind === 'created' && second.kind === 'replay') {
      expect(second.operation.id).toBe(first.operation.id);
    }
    expect(n).toBe(1);
  });

  it('handles unique-violation races by re-reading the winner', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    const winner = await stores.operations.insertPending({
      id: 'winner',
      operationType: 'ensure_funded',
      projectId: undefined,
      environmentId: undefined,
      idempotencyKey: 'race-key',
      requestedBy: 'cred-1',
      startedAt: clock.now(),
    });

    let lookups = 0;
    const operations: FundingOperationRepository = {
      ...stores.operations,
      findByIdempotencyKey: async (requestedBy, key) => {
        lookups += 1;
        if (lookups === 1) {
          return undefined;
        }
        return stores.operations.findByIdempotencyKey(requestedBy, key);
      },
      insertPending: () => Promise.reject(new UniqueViolationError()),
    };

    const result = await ensureIdempotentOperation(
      {
        operations,
        clock,
        idGenerator: { next: () => 'loser' },
      },
      {
        operationType: 'ensure_funded',
        projectId: undefined,
        environmentId: undefined,
        idempotencyKey: 'race-key',
        requestedBy: 'cred-1',
      },
    );

    expect(result).toEqual({ kind: 'replay', operation: winner });
    expect(lookups).toBe(2);
  });
});
