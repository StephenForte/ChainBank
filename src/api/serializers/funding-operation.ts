import type { GetOperationStatusResult } from '../../app/funding/get-operation-status.js';
import type { FundingTransaction } from '../../app/ports.js';

export interface FundingOperationChainResource {
  readonly slug: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
}

/**
 * Chain facts for the treasury that signed this operation's transaction.
 * Taken from that treasury row. Never the process default chain.
 */
export interface FundingOperationChainContext extends FundingOperationChainResource {
  readonly explorerBaseUrl: string;
  readonly treasuryAddress: string;
}

export interface FundingOperationTransactionResource {
  readonly id: string;
  readonly status: string;
  readonly amountWei: string;
  readonly hash: string | null;
  readonly explorerUrl: string | null;
  readonly nonce: number | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
  /** Address of the treasury that signed the transaction. Null when that row is gone. */
  readonly treasuryAddress: string | null;
  /** Chain of the signing treasury. Null when that row is gone. */
  readonly chain: FundingOperationChainResource | null;
}

/**
 * Wire representation of a funding operation status query (P2-US3).
 *
 * Wei quantities are decimal strings. Reverted/replaced/dropped appear as
 * distinct top-level `status` values with their error codes — never conflated
 * into a generic failure. `submission_unknown` surfaces as `pending` with
 * `reason: "submission-unconfirmed"`.
 */
export interface FundingOperationResource {
  readonly id: string;
  readonly operationType: string;
  readonly status: string;
  readonly reason: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly transaction: FundingOperationTransactionResource | null;
}

export function serializeFundingOperation(
  result: GetOperationStatusResult,
  transactionChain: FundingOperationChainContext | undefined,
): FundingOperationResource {
  const { operation, transaction, status, reason } = result;
  return {
    id: operation.id,
    operationType: operation.operationType,
    status,
    reason: reason ?? null,
    projectId: operation.projectId ?? null,
    environmentId: operation.environmentId ?? null,
    errorCode: operation.errorCode ?? null,
    errorSummary: operation.errorSummary ?? null,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
    transaction:
      transaction === undefined ? null : serializeFundingTransaction(transaction, transactionChain),
  };
}

function serializeFundingTransaction(
  transaction: FundingTransaction,
  transactionChain: FundingOperationChainContext | undefined,
): FundingOperationTransactionResource {
  const hash = transaction.transactionHash ?? null;
  return {
    id: transaction.id,
    status: transaction.status,
    amountWei: transaction.amountWei.toString(),
    hash,
    explorerUrl:
      hash === null || transactionChain === undefined
        ? null
        : `${stripTrailingSlash(transactionChain.explorerBaseUrl)}/tx/${hash}`,
    nonce: transaction.nonce ?? null,
    errorCode: transaction.errorCode ?? null,
    createdAt: transaction.createdAt.toISOString(),
    submittedAt: transaction.submittedAt?.toISOString() ?? null,
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
    treasuryAddress: transactionChain?.treasuryAddress ?? null,
    chain:
      transactionChain === undefined
        ? null
        : {
            slug: transactionChain.slug,
            chainId: transactionChain.chainId,
            displayName: transactionChain.displayName,
            nativeSymbol: transactionChain.nativeSymbol,
          },
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
