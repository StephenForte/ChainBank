import { and, eq, inArray } from 'drizzle-orm';
import type {
  FundingTransaction,
  FundingTransactionRepository,
  InsertFundingTransactionInput,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import {
  canTransitionTransactionStatus,
  type FundingTransactionStatus,
} from '../../../domain/funding/statuses.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { fundingTransactions, type FundingTransactionRow } from '../schema.js';

export function createFundingTransactionRepository(db: Database): FundingTransactionRepository {
  return {
    async findById(id: string): Promise<FundingTransaction | undefined> {
      return withDatabaseErrors('funding_transactions.findById', async () => {
        const row = await db.query.fundingTransactions.findFirst({
          where: eq(fundingTransactions.id, id),
        });
        return row === undefined ? undefined : toFundingTransaction(row);
      });
    },

    async findByOperationId(operationId: string): Promise<FundingTransaction | undefined> {
      return withDatabaseErrors('funding_transactions.findByOperationId', async () => {
        const row = await db.query.fundingTransactions.findFirst({
          where: eq(fundingTransactions.operationId, operationId),
        });
        return row === undefined ? undefined : toFundingTransaction(row);
      });
    },

    async findPendingByManagedWallet(managedWalletId: string): Promise<FundingTransaction | undefined> {
      return withDatabaseErrors('funding_transactions.findPendingByManagedWallet', async () => {
        const row = await db.query.fundingTransactions.findFirst({
          where: and(
            eq(fundingTransactions.managedWalletId, managedWalletId),
            inArray(fundingTransactions.status, ['created', 'submitted']),
          ),
        });
        return row === undefined ? undefined : toFundingTransaction(row);
      });
    },

    async insertCreated(input: InsertFundingTransactionInput): Promise<FundingTransaction> {
      return withDatabaseErrors('funding_transactions.insertCreated', async () => {
        const [row] = await db
          .insert(fundingTransactions)
          .values({
            id: input.id,
            operationId: input.operationId,
            treasuryId: input.treasuryId,
            managedWalletId: input.managedWalletId,
            amountWei: weiToDatabaseNumeric(input.amountWei, 'amountWei'),
            status: 'created',
            createdAt: input.createdAt,
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Funding transaction insert returned no row');
        }
        return toFundingTransaction(row);
      });
    },

    async markSubmitted(
      id: string,
      input: { readonly transactionHash: string; readonly nonce: number; readonly submittedAt: Date },
    ): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'submitted', {
        transactionHash: input.transactionHash,
        nonce: input.nonce,
        submittedAt: input.submittedAt,
      });
    },

    async markConfirmed(id: string, confirmedAt: Date): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'confirmed', { confirmedAt });
    },

    async markReverted(id: string, errorCode: string): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'reverted', { errorCode });
    },

    async markReplaced(id: string, errorCode: string): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'replaced', { errorCode });
    },

    async markDropped(id: string, errorCode: string): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'dropped', { errorCode });
    },

    async markFailed(id: string, errorCode: string): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'failed', { errorCode });
    },
  };
}

async function transitionTransaction(
  db: Database,
  id: string,
  to: FundingTransactionStatus,
  fields: {
    readonly transactionHash?: string;
    readonly nonce?: number;
    readonly submittedAt?: Date;
    readonly confirmedAt?: Date;
    readonly errorCode?: string;
  },
): Promise<FundingTransaction> {
  return withDatabaseErrors(`funding_transactions.mark_${to}`, async () => {
    const existing = await db.query.fundingTransactions.findFirst({
      where: eq(fundingTransactions.id, id),
    });
    if (existing === undefined) {
      throw new ChainBankError('FUNDING_TRANSACTION_NOT_FOUND', `Funding transaction ${id} was not found`);
    }

    const from = existing.status;
    if (!canTransitionTransactionStatus(from, to)) {
      throw new ChainBankError(
        'INVALID_STATUS_TRANSITION',
        `Cannot transition funding transaction from ${from} to ${to}`,
        {
          publicMessage: 'The funding transaction cannot transition to that status.',
          context: { transactionId: id, from, to },
        },
      );
    }

    const [row] = await db
      .update(fundingTransactions)
      .set({
        status: to,
        transactionHash: fields.transactionHash ?? existing.transactionHash,
        nonce: fields.nonce ?? existing.nonce,
        submittedAt: fields.submittedAt ?? existing.submittedAt,
        confirmedAt: fields.confirmedAt ?? existing.confirmedAt,
        errorCode: fields.errorCode ?? existing.errorCode,
      })
      .where(eq(fundingTransactions.id, id))
      .returning();

    if (row === undefined) {
      throw new ChainBankError('DATABASE_UNAVAILABLE', `Funding transaction ${id} update returned no row`);
    }
    return toFundingTransaction(row);
  });
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
