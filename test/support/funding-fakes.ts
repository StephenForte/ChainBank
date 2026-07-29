import type {
  FundingDispatchLock,
  FundingDispatchUnitOfWork,
  FundingOperation,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionListPage,
  FundingTransactionRepository,
  InsertFundingOperationInput,
  InsertFundingTransactionInput,
  TransactionReceiptTracker,
  TransactionTrackingOutcome,
  TreasurySigner,
} from '../../src/app/ports.js';
import { ChainBankError } from '../../src/domain/errors.js';
import {
  canTransitionOperationStatus,
  canTransitionTransactionStatus,
  isPendingTransactionStatus,
  type FundingOperationStatus,
  type FundingTransactionStatus,
} from '../../src/domain/funding/statuses.js';
import { isUniqueViolation } from '../../src/shared/postgres-error.js';

/** Simulates a Postgres unique-violation for idempotency race tests. */
export class UniqueViolationError extends Error {
  readonly code = '23505';
  constructor() {
    super('duplicate key value violates unique constraint');
    this.name = 'UniqueViolationError';
  }
}

export function createInMemoryFundingStores(): {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly lock: FundingDispatchLock;
  readonly opsById: Map<string, FundingOperation>;
  readonly txsById: Map<string, FundingTransaction>;
} {
  const opsById = new Map<string, FundingOperation>();
  const txsById = new Map<string, FundingTransaction>();

  const operations: FundingOperationRepository = {
    findById(id) {
      return Promise.resolve(opsById.get(id));
    },
    findByIdempotencyKey(requestedBy, idempotencyKey) {
      for (const op of opsById.values()) {
        if (op.requestedBy === requestedBy && op.idempotencyKey === idempotencyKey) {
          return Promise.resolve(op);
        }
      }
      return Promise.resolve(undefined);
    },
    insertPending(input: InsertFundingOperationInput) {
      if (input.idempotencyKey !== undefined) {
        for (const op of opsById.values()) {
          if (op.requestedBy === input.requestedBy && op.idempotencyKey === input.idempotencyKey) {
            return Promise.reject(new UniqueViolationError());
          }
        }
      }
      const operation: FundingOperation = {
        id: input.id,
        operationType: input.operationType,
        projectId: input.projectId,
        environmentId: input.environmentId,
        idempotencyKey: input.idempotencyKey,
        status: 'pending',
        requestedBy: input.requestedBy,
        startedAt: input.startedAt,
        completedAt: undefined,
        errorCode: undefined,
        errorSummary: undefined,
      };
      opsById.set(operation.id, operation);
      return Promise.resolve(operation);
    },
    markInProgress(id) {
      return Promise.resolve(transitionOp(opsById, id, 'in_progress', {}));
    },
    markSucceeded(id, completedAt) {
      return Promise.resolve(transitionOp(opsById, id, 'succeeded', { completedAt }));
    },
    markFailed(id, errorCode, errorSummary, completedAt) {
      return Promise.resolve(transitionOp(opsById, id, 'failed', { errorCode, errorSummary, completedAt }));
    },
    markAbandoned(id, errorCode, errorSummary, completedAt) {
      return Promise.resolve(
        transitionOp(opsById, id, 'abandoned', { errorCode, errorSummary, completedAt }),
      );
    },
  };

  const transactions: FundingTransactionRepository = {
    findById(id) {
      return Promise.resolve(txsById.get(id));
    },
    findByOperationId(operationId) {
      for (const tx of txsById.values()) {
        if (tx.operationId === operationId) {
          return Promise.resolve(tx);
        }
      }
      return Promise.resolve(undefined);
    },
    findPendingByManagedWallet(managedWalletId) {
      for (const tx of txsById.values()) {
        if (tx.managedWalletId === managedWalletId && isPendingTransactionStatus(tx.status)) {
          return Promise.resolve(tx);
        }
      }
      return Promise.resolve(undefined);
    },
    sumInFlightAmountWeiByTreasury(treasuryId) {
      let total = 0n;
      for (const tx of txsById.values()) {
        if (tx.treasuryId === treasuryId && isPendingTransactionStatus(tx.status)) {
          total += tx.amountWei;
        }
      }
      return Promise.resolve(total);
    },
    insertCreated(input: InsertFundingTransactionInput) {
      const tx: FundingTransaction = {
        id: input.id,
        operationId: input.operationId,
        treasuryId: input.treasuryId,
        managedWalletId: input.managedWalletId,
        amountWei: input.amountWei,
        transactionHash: undefined,
        nonce: undefined,
        status: 'created',
        errorCode: undefined,
        createdAt: input.createdAt,
        submittedAt: undefined,
        confirmedAt: undefined,
      };
      txsById.set(tx.id, tx);
      return Promise.resolve(tx);
    },
    markSubmitted(id, input) {
      return Promise.resolve(
        transitionTx(txsById, id, 'submitted', {
          transactionHash: input.transactionHash,
          nonce: input.nonce,
          submittedAt: input.submittedAt,
        }),
      );
    },
    markSubmissionUnknown(id, input) {
      return Promise.resolve(
        transitionTx(txsById, id, 'submission_unknown', {
          nonce: input.nonce,
          errorCode: input.errorCode,
        }),
      );
    },
    markConfirmed(id, confirmedAt) {
      return Promise.resolve(transitionTx(txsById, id, 'confirmed', { confirmedAt }));
    },
    markReverted(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'reverted', { errorCode }));
    },
    markReplaced(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'replaced', { errorCode }));
    },
    markDropped(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'dropped', { errorCode }));
    },
    markFailed(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'failed', { errorCode }));
    },
    list() {
      return Promise.resolve({ items: [], total: 0 } satisfies FundingTransactionListPage);
    },
  };

  const lock: FundingDispatchLock = {
    runExclusive(_treasuryId, _evmChainId, work) {
      const uow: FundingDispatchUnitOfWork = { operations, transactions };
      return work(uow);
    },
  };

  return { operations, transactions, lock, opsById, txsById };
}

function transitionOp(
  store: Map<string, FundingOperation>,
  id: string,
  to: FundingOperationStatus,
  fields: {
    readonly completedAt?: Date;
    readonly errorCode?: string;
    readonly errorSummary?: string;
  },
): FundingOperation {
  const existing = store.get(id);
  if (existing === undefined) {
    throw new ChainBankError('FUNDING_OPERATION_NOT_FOUND', `missing ${id}`);
  }
  if (!canTransitionOperationStatus(existing.status, to)) {
    throw new ChainBankError('INVALID_STATUS_TRANSITION', `${existing.status} -> ${to}`);
  }
  const next: FundingOperation = {
    ...existing,
    status: to,
    completedAt: fields.completedAt ?? existing.completedAt,
    errorCode: fields.errorCode ?? existing.errorCode,
    errorSummary: fields.errorSummary ?? existing.errorSummary,
  };
  store.set(id, next);
  return next;
}

function transitionTx(
  store: Map<string, FundingTransaction>,
  id: string,
  to: FundingTransactionStatus,
  fields: {
    readonly transactionHash?: string;
    readonly nonce?: number;
    readonly submittedAt?: Date;
    readonly confirmedAt?: Date;
    readonly errorCode?: string;
  },
): FundingTransaction {
  const existing = store.get(id);
  if (existing === undefined) {
    throw new ChainBankError('FUNDING_TRANSACTION_NOT_FOUND', `missing ${id}`);
  }
  if (!canTransitionTransactionStatus(existing.status, to)) {
    throw new ChainBankError('INVALID_STATUS_TRANSITION', `${existing.status} -> ${to}`);
  }
  const next: FundingTransaction = {
    ...existing,
    status: to,
    transactionHash: fields.transactionHash ?? existing.transactionHash,
    nonce: fields.nonce ?? existing.nonce,
    submittedAt: fields.submittedAt ?? existing.submittedAt,
    confirmedAt: fields.confirmedAt ?? existing.confirmedAt,
    errorCode: fields.errorCode ?? existing.errorCode,
  };
  store.set(id, next);
  return next;
}

export function createFakeSigner(overrides: {
  readonly send?: TreasurySigner['sendNativeTransfer'];
  readonly chainMatches?: boolean;
  readonly nonce?: number;
  readonly estimatedCostWei?: bigint;
  readonly address?: string;
}): TreasurySigner & { readonly sendCalls: number } {
  const state = { sendCalls: 0 };
  const signer: TreasurySigner & { readonly sendCalls: number } = {
    get address() {
      return overrides.address ?? '0x1111111111111111111111111111111111111111';
    },
    get sendCalls() {
      return state.sendCalls;
    },
    verifyChainId() {
      return Promise.resolve({
        matches: overrides.chainMatches ?? true,
        observedChainId: overrides.chainMatches === false ? 1 : 11_155_111,
      });
    },
    getTransactionCount() {
      return Promise.resolve(overrides.nonce ?? 7);
    },
    estimateTransferCostWei() {
      return Promise.resolve(overrides.estimatedCostWei ?? 21_000n);
    },
    sendNativeTransfer(input) {
      state.sendCalls += 1;
      if (overrides.send !== undefined) {
        return overrides.send(input);
      }
      return Promise.resolve({
        transactionHash: `0x${'ab'.repeat(32)}`,
      });
    },
  };
  return signer;
}

export function createFakeReceiptTracker(
  outcome: TransactionTrackingOutcome | (() => TransactionTrackingOutcome),
): TransactionReceiptTracker {
  return {
    waitForOutcome() {
      return Promise.resolve(typeof outcome === 'function' ? outcome() : outcome);
    },
  };
}

export { isUniqueViolation };
