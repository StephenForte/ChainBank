import type { Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import {
  assertNever,
  type FundingOperationStatus,
  type FundingTransactionStatus,
} from '../../domain/funding/statuses.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { authorizeScope } from '../auth/authorize-scope.js';
import type {
  CredentialScopeRepository,
  FundingOperation,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  TransactionReceiptTracker,
} from '../ports.js';
import { trackTransaction, type TrackTransactionDependencies } from './track-transaction.js';

/**
 * Caller-facing status for GET /v1/funding-operations/:id (P2-US3).
 *
 * Reverted / replaced / dropped are first-class — never collapsed into a generic
 * `failed` so startup and operators can branch on the exact outcome. Timeout and
 * `submission_unknown` both surface as `pending`.
 */
export type FundingOperationViewStatus =
  'pending' | 'in_progress' | 'succeeded' | 'failed' | 'abandoned' | 'reverted' | 'replaced' | 'dropped';

/** Distinguishes pending variants that are not simply waiting on a receipt. */
export type FundingOperationStatusReason = 'submission-unconfirmed';

export interface GetOperationStatusDependencies {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly credentialScopes: CredentialScopeRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  /**
   * Configured treasury address used as `senderAddress` when resuming
   * receipt tracking. Never a signer — this endpoint is read-plus-track only.
   */
  readonly treasuryAddress: string;
}

export interface GetOperationStatusInput {
  readonly operationId: string;
  readonly role: Role;
  readonly credentialId: string;
  readonly correlationId: string;
}

export interface GetOperationStatusResult {
  readonly operation: FundingOperation;
  readonly transaction: FundingTransaction | undefined;
  readonly status: FundingOperationViewStatus;
  readonly reason: FundingOperationStatusReason | undefined;
}

/**
 * Loads a funding operation, authorizes the caller, and resumes confirmation
 * tracking when the linked transaction is still `submitted`.
 *
 * Does not dispatch, sign, or construct a signer. The only writes are the
 * status transitions {@link trackTransaction} already performs.
 */
export async function getOperationStatus(
  dependencies: GetOperationStatusDependencies,
  input: GetOperationStatusInput,
): Promise<GetOperationStatusResult> {
  const operation = await dependencies.operations.findById(input.operationId);
  if (operation === undefined) {
    throw new ChainBankError(
      'FUNDING_OPERATION_NOT_FOUND',
      `Funding operation ${input.operationId} does not exist`,
    );
  }

  await authorizeOperationRead(dependencies, input, operation);

  const transaction = await dependencies.transactions.findByOperationId(operation.id);

  if (transaction === undefined) {
    return {
      operation,
      transaction: undefined,
      status: mapOperationOnlyStatus(operation.status),
      reason: undefined,
    };
  }

  if (transaction.status === 'submission_unknown') {
    // No hash — trackTransaction correctly refuses. Phase 4 reconciliation
    // resolves these by nonce; this endpoint only surfaces the distinction.
    return {
      operation,
      transaction,
      status: 'pending',
      reason: 'submission-unconfirmed',
    };
  }

  if (transaction.status === 'submitted') {
    const trackDeps: TrackTransactionDependencies = {
      operations: dependencies.operations,
      transactions: dependencies.transactions,
      receiptTracker: dependencies.receiptTracker,
      clock: dependencies.clock,
      logger: dependencies.logger,
      confirmations: dependencies.confirmations,
      confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
    };
    const tracked = await trackTransaction(trackDeps, {
      transactionId: transaction.id,
      correlationId: input.correlationId,
      senderAddress: dependencies.treasuryAddress,
    });
    return {
      operation: tracked.operation,
      transaction: tracked.transaction,
      status: mapTrackOutcomeStatus(tracked.kind, tracked.transaction),
      reason: undefined,
    };
  }

  return {
    operation,
    transaction,
    status: mapStoredTransactionStatus(transaction.status, operation.status),
    reason: undefined,
  };
}

async function authorizeOperationRead(
  dependencies: GetOperationStatusDependencies,
  input: GetOperationStatusInput,
  operation: FundingOperation,
): Promise<void> {
  if (input.role === 'operator' || input.role === 'read-only') {
    return;
  }

  if (input.role === 'project-service') {
    // Deny by default when the operation is not tied to a project (e.g. an
    // internal/cron-originated row). Project-service must never see those.
    if (operation.projectId === undefined) {
      throw new ChainBankError(
        'SCOPE_DENIED',
        'Project-service credentials cannot access funding operations without a project scope',
        {
          context: {
            credentialId: input.credentialId,
            operationId: operation.id,
            action: 'read',
          },
        },
      );
    }

    // Scope check is project-level only (T2.3): env-specific scope rows still
    // grant project reads via hasProjectScope. Deny when projectId is null above.
    await authorizeScope(
      { credentialScopes: dependencies.credentialScopes },
      {
        role: input.role,
        credentialId: input.credentialId,
        action: 'read',
        projectId: operation.projectId,
      },
    );
    return;
  }

  throw new ChainBankError(
    'INSUFFICIENT_ROLE',
    `Role "${input.role}" is not permitted to read funding operations`,
    { context: { role: input.role, action: 'read' } },
  );
}

function mapOperationOnlyStatus(status: FundingOperationStatus): FundingOperationViewStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    default:
      return assertNever(status, 'FundingOperationStatus');
  }
}

function mapTrackOutcomeStatus(
  kind: 'confirmed' | 'reverted' | 'replaced' | 'dropped' | 'pending' | 'already-terminal',
  transaction: FundingTransaction,
): FundingOperationViewStatus {
  switch (kind) {
    case 'confirmed':
      return 'succeeded';
    case 'reverted':
      return 'reverted';
    case 'replaced':
      return 'replaced';
    case 'dropped':
      return 'dropped';
    case 'pending':
      return 'pending';
    case 'already-terminal':
      return mapStoredTransactionStatus(transaction.status, 'failed');
    default:
      return assertNever(kind, 'TrackTransactionResult.kind');
  }
}

function mapStoredTransactionStatus(
  transactionStatus: FundingTransactionStatus,
  operationStatus: FundingOperationStatus,
): FundingOperationViewStatus {
  switch (transactionStatus) {
    case 'confirmed':
      return 'succeeded';
    case 'reverted':
      return 'reverted';
    case 'replaced':
      return 'replaced';
    case 'dropped':
      return 'dropped';
    case 'failed':
      return 'failed';
    case 'created':
      return mapOperationOnlyStatus(operationStatus === 'pending' ? 'pending' : 'in_progress');
    case 'submitted':
      // Should have been resumed above; treat as still pending if reached.
      return 'pending';
    case 'submission_unknown':
      return 'pending';
    default:
      return assertNever(transactionStatus, 'FundingTransactionStatus');
  }
}
