/**
 * Contract C4 — funding operation and transaction status values.
 *
 * These strings are the DB enum and public API contract. Every switch on status
 * must be exhaustive so a new state cannot be silently ignored.
 */

export const FUNDING_OPERATION_STATUSES = [
  'pending',
  'in_progress',
  'succeeded',
  'failed',
  'abandoned',
] as const;

export type FundingOperationStatus = (typeof FUNDING_OPERATION_STATUSES)[number];

export const FUNDING_TRANSACTION_STATUSES = [
  'created',
  'submitted',
  'confirmed',
  'reverted',
  'replaced',
  'dropped',
  'failed',
] as const;

export type FundingTransactionStatus = (typeof FUNDING_TRANSACTION_STATUSES)[number];

export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}

/** Terminal operation statuses — no further dispatch work is expected. */
export function isTerminalOperationStatus(status: FundingOperationStatus): boolean {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return false;
    case 'succeeded':
    case 'failed':
    case 'abandoned':
      return true;
    default:
      return assertNever(status, 'FundingOperationStatus');
  }
}

/**
 * In-flight funding transactions that block another top-up to the same wallet.
 * Submission success (`submitted`) is intentionally not treated as confirmation.
 */
export function isPendingTransactionStatus(status: FundingTransactionStatus): boolean {
  switch (status) {
    case 'created':
    case 'submitted':
      return true;
    case 'confirmed':
    case 'reverted':
    case 'replaced':
    case 'dropped':
    case 'failed':
      return false;
    default:
      return assertNever(status, 'FundingTransactionStatus');
  }
}

/** Whether a transaction status means funds were transferred successfully. */
export function isSuccessfulTransactionStatus(status: FundingTransactionStatus): boolean {
  switch (status) {
    case 'confirmed':
      return true;
    case 'created':
    case 'submitted':
    case 'reverted':
    case 'replaced':
    case 'dropped':
    case 'failed':
      return false;
    default:
      return assertNever(status, 'FundingTransactionStatus');
  }
}

/**
 * Allowed operation-status transitions. Unknown transitions fail closed.
 *
 * pending → in_progress | failed | abandoned | succeeded (no-op / blocked finalize)
 * in_progress → succeeded | failed | abandoned
 * terminal → (none)
 */
export function canTransitionOperationStatus(
  from: FundingOperationStatus,
  to: FundingOperationStatus,
): boolean {
  switch (from) {
    case 'pending':
      switch (to) {
        case 'in_progress':
        case 'succeeded':
        case 'failed':
        case 'abandoned':
          return true;
        case 'pending':
          return false;
        default:
          return assertNever(to, 'FundingOperationStatus');
      }
    case 'in_progress':
      switch (to) {
        case 'succeeded':
        case 'failed':
        case 'abandoned':
          return true;
        case 'pending':
        case 'in_progress':
          return false;
        default:
          return assertNever(to, 'FundingOperationStatus');
      }
    case 'succeeded':
    case 'failed':
    case 'abandoned':
      return false;
    default:
      return assertNever(from, 'FundingOperationStatus');
  }
}

/**
 * Allowed transaction-status transitions.
 *
 * created → submitted | failed
 * submitted → confirmed | reverted | replaced | dropped | failed
 * terminal → (none)
 */
export function canTransitionTransactionStatus(
  from: FundingTransactionStatus,
  to: FundingTransactionStatus,
): boolean {
  switch (from) {
    case 'created':
      switch (to) {
        case 'submitted':
        case 'failed':
          return true;
        case 'created':
        case 'confirmed':
        case 'reverted':
        case 'replaced':
        case 'dropped':
          return false;
        default:
          return assertNever(to, 'FundingTransactionStatus');
      }
    case 'submitted':
      switch (to) {
        case 'confirmed':
        case 'reverted':
        case 'replaced':
        case 'dropped':
        case 'failed':
          return true;
        case 'created':
        case 'submitted':
          return false;
        default:
          return assertNever(to, 'FundingTransactionStatus');
      }
    case 'confirmed':
    case 'reverted':
    case 'replaced':
    case 'dropped':
    case 'failed':
      return false;
    default:
      return assertNever(from, 'FundingTransactionStatus');
  }
}
