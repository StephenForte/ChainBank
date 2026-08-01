import { and, eq, isNotNull } from 'drizzle-orm';
import type { FundingTransaction, ReconciliationFundingQuery } from '../../../app/ports.js';
import { weiFromDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { fundingTransactions, type FundingTransactionRow } from '../schema.js';

/**
 * Reconciliation-specific funding_transactions queries (C14).
 * New adapter file so T4.1 does not edit the dispatch-owned repository.
 */
export function createReconciliationFundingQuery(db: Database): ReconciliationFundingQuery {
  return {
    async listSubmissionUnknownByTreasury(treasuryId: string): Promise<readonly FundingTransaction[]> {
      return withDatabaseErrors('reconciliation_funding.listSubmissionUnknownByTreasury', async () => {
        const rows = await db
          .select()
          .from(fundingTransactions)
          .where(
            and(
              eq(fundingTransactions.treasuryId, treasuryId),
              eq(fundingTransactions.status, 'submission_unknown'),
            ),
          );

        return rows.map(toFundingTransaction);
      });
    },

    async listRecordedTransactionHashesByTreasury(treasuryId: string): Promise<readonly string[]> {
      return withDatabaseErrors(
        'reconciliation_funding.listRecordedTransactionHashesByTreasury',
        async () => {
          const rows = await db
            .select({ transactionHash: fundingTransactions.transactionHash })
            .from(fundingTransactions)
            .where(
              and(
                eq(fundingTransactions.treasuryId, treasuryId),
                isNotNull(fundingTransactions.transactionHash),
              ),
            );

          return rows.flatMap((row) =>
            row.transactionHash === null ? [] : [row.transactionHash.toLowerCase()],
          );
        },
      );
    },
  };
}

function toFundingTransaction(row: FundingTransactionRow): FundingTransaction {
  return {
    id: row.id,
    operationId: row.operationId,
    treasuryId: row.treasuryId,
    managedWalletId: row.managedWalletId,
    amountWei: weiFromDatabaseNumeric(row.amountWei, 'amountWei'),
    transactionHash: row.transactionHash ?? undefined,
    nonce: row.nonce ?? undefined,
    status: row.status,
    errorCode: row.errorCode ?? undefined,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt ?? undefined,
    confirmedAt: row.confirmedAt ?? undefined,
  };
}
