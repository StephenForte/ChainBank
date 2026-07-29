import type { Clock, IdGenerator } from '../../domain/ports.js';
import { isUniqueViolation } from '../../shared/postgres-error.js';
import type { FundingOperation, FundingOperationRepository } from '../ports.js';

export interface EnsureIdempotentOperationInput {
  readonly operationType: string;
  readonly projectId: string | undefined;
  readonly environmentId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly requestedBy: string;
}

export type EnsureIdempotentOperationResult =
  | { readonly kind: 'created'; readonly operation: FundingOperation }
  | { readonly kind: 'replay'; readonly operation: FundingOperation };

/**
 * Persists a pending funding_operations row before any RPC submission.
 *
 * When an idempotency key is present, a prior row is returned as a replay.
 * Concurrent inserts racing the partial unique index (requested_by, key) are
 * resolved by re-reading the winning row.
 */
export async function ensureIdempotentOperation(
  dependencies: {
    readonly operations: FundingOperationRepository;
    readonly clock: Clock;
    readonly idGenerator: IdGenerator;
  },
  input: EnsureIdempotentOperationInput,
): Promise<EnsureIdempotentOperationResult> {
  if (input.idempotencyKey !== undefined && input.idempotencyKey.trim() !== '') {
    const existing = await dependencies.operations.findByIdempotencyKey(
      input.requestedBy,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      return { kind: 'replay', operation: existing };
    }
  }

  const pending = {
    id: dependencies.idGenerator.next(),
    operationType: input.operationType,
    projectId: input.projectId,
    environmentId: input.environmentId,
    idempotencyKey:
      input.idempotencyKey !== undefined && input.idempotencyKey.trim() !== ''
        ? input.idempotencyKey
        : undefined,
    requestedBy: input.requestedBy,
    startedAt: dependencies.clock.now(),
  };

  try {
    const operation = await dependencies.operations.insertPending(pending);
    return { kind: 'created', operation };
  } catch (error) {
    if (pending.idempotencyKey !== undefined && isUniqueViolation(error)) {
      const winner = await dependencies.operations.findByIdempotencyKey(
        input.requestedBy,
        pending.idempotencyKey,
      );
      if (winner !== undefined) {
        return { kind: 'replay', operation: winner };
      }
    }
    throw error;
  }
}
