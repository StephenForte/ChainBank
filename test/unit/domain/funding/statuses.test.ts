import { describe, expect, it } from 'vitest';
import {
  canTransitionOperationStatus,
  canTransitionTransactionStatus,
  FUNDING_OPERATION_STATUSES,
  FUNDING_TRANSACTION_STATUSES,
  isPendingTransactionStatus,
  isSuccessfulTransactionStatus,
  isTerminalOperationStatus,
  type FundingOperationStatus,
  type FundingTransactionStatus,
} from '../../../../src/domain/funding/statuses.js';

describe('funding status state machines (C4)', () => {
  it('enumerates exactly the contract C4 operation statuses', () => {
    expect([...FUNDING_OPERATION_STATUSES]).toEqual([
      'pending',
      'in_progress',
      'succeeded',
      'failed',
      'abandoned',
    ]);
  });

  it('enumerates exactly the contract C4 transaction statuses', () => {
    expect([...FUNDING_TRANSACTION_STATUSES]).toEqual([
      'created',
      'submitted',
      'submission_unknown',
      'confirmed',
      'reverted',
      'replaced',
      'dropped',
      'failed',
    ]);
  });

  it('classifies terminal and pending statuses exhaustively', () => {
    const operationCases: ReadonlyArray<{
      readonly status: FundingOperationStatus;
      readonly terminal: boolean;
    }> = [
      { status: 'pending', terminal: false },
      { status: 'in_progress', terminal: false },
      { status: 'succeeded', terminal: true },
      { status: 'failed', terminal: true },
      { status: 'abandoned', terminal: true },
    ];
    for (const entry of operationCases) {
      expect(isTerminalOperationStatus(entry.status)).toBe(entry.terminal);
    }

    const transactionCases: ReadonlyArray<{
      readonly status: FundingTransactionStatus;
      readonly pending: boolean;
      readonly successful: boolean;
    }> = [
      { status: 'created', pending: true, successful: false },
      { status: 'submitted', pending: true, successful: false },
      // Non-terminal on purpose: the transfer may still be in the mempool.
      { status: 'submission_unknown', pending: true, successful: false },
      { status: 'confirmed', pending: false, successful: true },
      { status: 'reverted', pending: false, successful: false },
      { status: 'replaced', pending: false, successful: false },
      { status: 'dropped', pending: false, successful: false },
      { status: 'failed', pending: false, successful: false },
    ];
    for (const entry of transactionCases) {
      expect(isPendingTransactionStatus(entry.status)).toBe(entry.pending);
      expect(isSuccessfulTransactionStatus(entry.status)).toBe(entry.successful);
    }
  });

  it('allows only documented operation transitions', () => {
    expect(canTransitionOperationStatus('pending', 'in_progress')).toBe(true);
    expect(canTransitionOperationStatus('pending', 'succeeded')).toBe(true);
    expect(canTransitionOperationStatus('in_progress', 'succeeded')).toBe(true);
    expect(canTransitionOperationStatus('succeeded', 'failed')).toBe(false);
    expect(canTransitionOperationStatus('failed', 'pending')).toBe(false);
  });

  it('allows only documented transaction transitions and never treats submitted as confirmed', () => {
    expect(canTransitionTransactionStatus('created', 'submitted')).toBe(true);
    expect(canTransitionTransactionStatus('submitted', 'confirmed')).toBe(true);
    expect(canTransitionTransactionStatus('submitted', 'reverted')).toBe(true);
    expect(canTransitionTransactionStatus('submitted', 'replaced')).toBe(true);
    expect(canTransitionTransactionStatus('submitted', 'dropped')).toBe(true);
    expect(canTransitionTransactionStatus('created', 'confirmed')).toBe(false);
    expect(canTransitionTransactionStatus('confirmed', 'submitted')).toBe(false);
  });

  it('treats submission_unknown as a resolvable, non-terminal state', () => {
    expect(canTransitionTransactionStatus('created', 'submission_unknown')).toBe(true);
    // Reconciliation may promote it once the hash is observed, or close it out.
    expect(canTransitionTransactionStatus('submission_unknown', 'submitted')).toBe(true);
    expect(canTransitionTransactionStatus('submission_unknown', 'confirmed')).toBe(true);
    expect(canTransitionTransactionStatus('submission_unknown', 'replaced')).toBe(true);
    expect(canTransitionTransactionStatus('submission_unknown', 'dropped')).toBe(true);
    expect(canTransitionTransactionStatus('submission_unknown', 'failed')).toBe(true);
    // Never reachable from a terminal state.
    expect(canTransitionTransactionStatus('failed', 'submission_unknown')).toBe(false);
    expect(canTransitionTransactionStatus('confirmed', 'submission_unknown')).toBe(false);
    expect(canTransitionTransactionStatus('submitted', 'submission_unknown')).toBe(false);
  });
});
