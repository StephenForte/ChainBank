import { ChainBankError } from '../../domain/errors.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import type {
  FundingOperation,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  TransactionReceiptTracker,
  TransactionTrackingOutcome,
} from '../ports.js';

export interface TrackTransactionDependencies {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
}

export interface TrackTransactionInput {
  readonly transactionId: string;
  readonly correlationId: string;
  /** Treasury address that signed the transfer; used for nonce-based probing. */
  readonly senderAddress: string;
}

export type TrackTransactionResult =
  | {
      readonly kind: 'confirmed';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    }
  | {
      readonly kind: 'reverted';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    }
  | {
      readonly kind: 'replaced';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    }
  | {
      readonly kind: 'dropped';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    }
  | {
      readonly kind: 'pending';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    }
  | {
      readonly kind: 'already-terminal';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    };

/**
 * Waits for confirmation of a previously submitted funding transaction and
 * maps the outcome to confirmed / reverted / replaced / dropped / pending.
 *
 * Timeout ⇒ `pending` (D4) — never a false failure. Submission success must
 * already be persisted as `submitted` before this runs.
 */
export async function trackTransaction(
  dependencies: TrackTransactionDependencies,
  input: TrackTransactionInput,
): Promise<TrackTransactionResult> {
  const transaction = await dependencies.transactions.findById(input.transactionId);
  if (transaction === undefined) {
    throw new ChainBankError(
      'FUNDING_TRANSACTION_NOT_FOUND',
      `Funding transaction ${input.transactionId} does not exist`,
    );
  }

  const operation = await dependencies.operations.findById(transaction.operationId);
  if (operation === undefined) {
    throw new ChainBankError(
      'FUNDING_OPERATION_NOT_FOUND',
      `Funding operation ${transaction.operationId} does not exist`,
    );
  }

  switch (transaction.status) {
    case 'confirmed':
    case 'reverted':
    case 'replaced':
    case 'dropped':
    case 'failed':
      return { kind: 'already-terminal', operation, transaction };
    // Neither state has a recorded hash, so there is nothing to wait on.
    // Resolving an unknown submission is reconciliation's job — it must search
    // by nonce — not the receipt tracker's.
    case 'created':
    case 'submission_unknown':
      throw new ChainBankError(
        'INVALID_STATUS_TRANSITION',
        `Funding transaction ${transaction.id} has no confirmed submission; cannot track receipt`,
        {
          publicMessage: 'The funding transaction is not ready for confirmation tracking.',
          context: { transactionId: transaction.id, status: transaction.status },
        },
      );
    case 'submitted':
      break;
    default:
      return assertNever(transaction.status, 'FundingTransactionStatus');
  }

  if (transaction.transactionHash === undefined) {
    throw new ChainBankError(
      'INTERNAL_ERROR',
      `Funding transaction ${transaction.id} is submitted but has no transaction hash`,
    );
  }

  if (transaction.nonce === undefined) {
    throw new ChainBankError(
      'INTERNAL_ERROR',
      `Funding transaction ${transaction.id} is submitted but has no nonce`,
    );
  }

  const outcome = await dependencies.receiptTracker.waitForOutcome({
    transactionHash: transaction.transactionHash,
    confirmations: dependencies.confirmations,
    timeoutMs: dependencies.confirmationTimeoutMs,
    senderAddress: input.senderAddress,
    nonce: transaction.nonce,
  });

  return applyOutcome(dependencies, operation, transaction, outcome, input.correlationId);
}

async function applyOutcome(
  dependencies: TrackTransactionDependencies,
  operation: FundingOperation,
  transaction: FundingTransaction,
  outcome: TransactionTrackingOutcome,
  correlationId: string,
): Promise<TrackTransactionResult> {
  const completedAt = dependencies.clock.now();

  switch (outcome.kind) {
    case 'confirmed': {
      const updatedTx = await dependencies.transactions.markConfirmed(transaction.id, outcome.confirmedAt);
      const updatedOp = await dependencies.operations.markSucceeded(operation.id, completedAt);
      dependencies.logger.info(
        {
          correlationId,
          operationId: operation.id,
          transactionId: transaction.id,
          transactionHash: transaction.transactionHash,
        },
        'Funding transaction confirmed',
      );
      return { kind: 'confirmed', operation: updatedOp, transaction: updatedTx };
    }
    case 'reverted': {
      const updatedTx = await dependencies.transactions.markReverted(transaction.id, 'TRANSACTION_REVERTED');
      const updatedOp = await dependencies.operations.markFailed(
        operation.id,
        'TRANSACTION_REVERTED',
        'On-chain transaction reverted.',
        completedAt,
      );
      return { kind: 'reverted', operation: updatedOp, transaction: updatedTx };
    }
    case 'replaced': {
      const updatedTx = await dependencies.transactions.markReplaced(transaction.id, 'TRANSACTION_REPLACED');
      const updatedOp = await dependencies.operations.markFailed(
        operation.id,
        'TRANSACTION_REPLACED',
        'On-chain transaction was replaced.',
        completedAt,
      );
      return { kind: 'replaced', operation: updatedOp, transaction: updatedTx };
    }
    case 'dropped': {
      const updatedTx = await dependencies.transactions.markDropped(transaction.id, 'TRANSACTION_DROPPED');
      const updatedOp = await dependencies.operations.markFailed(
        operation.id,
        'TRANSACTION_DROPPED',
        'On-chain transaction was dropped.',
        completedAt,
      );
      return { kind: 'dropped', operation: updatedOp, transaction: updatedTx };
    }
    case 'pending': {
      // Timeout: leave statuses unchanged so a later status query can resume.
      dependencies.logger.info(
        {
          correlationId,
          operationId: operation.id,
          transactionId: transaction.id,
          transactionHash: transaction.transactionHash,
        },
        'Funding transaction confirmation timed out; remaining pending',
      );
      return { kind: 'pending', operation, transaction };
    }
    default:
      return assertNever(outcome, 'TransactionTrackingOutcome');
  }
}
