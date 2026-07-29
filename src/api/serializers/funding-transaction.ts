import type { FundingTransactionHistoryItem } from '../../app/ports.js';
import type { FundingOperationStatus, FundingTransactionStatus } from '../../domain/funding/statuses.js';
import { formatWeiAsEther } from '../../domain/wei.js';

export interface FundingTransactionResource {
  readonly id: string;
  readonly operation: {
    readonly id: string;
    readonly operationType: string;
    readonly status: FundingOperationStatus;
    readonly requestedBy: string;
    readonly startedAt: string;
    readonly completedAt: string | null;
  };
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly wallet: {
    readonly id: string;
    readonly role: string;
    readonly address: string;
  };
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly amountWei: string;
  readonly amountEther: string;
  readonly status: FundingTransactionStatus;
  readonly transactionHash: string | null;
  readonly explorerUrl: string | null;
  readonly nonce: number | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
}

export function serializeFundingTransaction(item: FundingTransactionHistoryItem): FundingTransactionResource {
  const transactionHash = item.transactionHash ?? null;
  return {
    id: item.id,
    operation: {
      id: item.operation.id,
      operationType: item.operation.operationType,
      status: item.operation.status,
      requestedBy: item.operation.requestedBy,
      startedAt: item.operation.startedAt.toISOString(),
      completedAt: item.operation.completedAt?.toISOString() ?? null,
    },
    project: {
      id: item.project.id,
      slug: item.project.slug,
      name: item.project.name,
      enabled: item.project.enabled,
    },
    environment: {
      id: item.environment.id,
      slug: item.environment.slug,
      name: item.environment.name,
      enabled: item.environment.enabled,
    },
    wallet: {
      id: item.wallet.id,
      role: item.wallet.role,
      address: item.wallet.addressDisplay,
    },
    chain: {
      slug: item.chain.slug,
      chainId: item.chain.chainId,
      displayName: item.chain.displayName,
      nativeSymbol: item.chain.nativeSymbol,
    },
    amountWei: item.amountWei.toString(),
    amountEther: formatWeiAsEther(item.amountWei),
    status: item.status,
    transactionHash,
    explorerUrl: transactionHash === null ? null : `${item.chain.explorerBaseUrl}/tx/${transactionHash}`,
    nonce: item.nonce ?? null,
    errorCode: item.errorCode ?? null,
    createdAt: item.createdAt.toISOString(),
    submittedAt: item.submittedAt?.toISOString() ?? null,
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
  };
}
