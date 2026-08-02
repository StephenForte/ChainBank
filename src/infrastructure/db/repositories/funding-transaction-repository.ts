import { and, count, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { getAddress } from 'viem';
import type {
  FundingTransaction,
  FundingTransactionHistoryItem,
  FundingTransactionListFilter,
  FundingTransactionListPage,
  FundingTransactionRepository,
  FundingTransactionScopeFilter,
  InsertBroadcastIntentInput,
  InsertFundingTransactionInput,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import {
  canTransitionTransactionStatus,
  type FundingTransactionStatus,
} from '../../../domain/funding/statuses.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import {
  chains,
  environments,
  fundingOperations,
  fundingTransactions,
  managedWallets,
  projects,
  type ChainRow,
  type EnvironmentRow,
  type FundingOperationRow,
  type FundingTransactionRow,
  type ManagedWalletRow,
  type ProjectRow,
} from '../schema.js';
import { toChainDescriptor } from './chain-repository.js';

/**
 * Statuses whose funds may still leave the treasury. Kept in sync with
 * `isPendingTransactionStatus`; both gate duplicate funding and reserve math.
 */
const IN_FLIGHT_STATUSES = ['created', 'submitted', 'submission_unknown'] as const;

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
            inArray(fundingTransactions.status, IN_FLIGHT_STATUSES),
          ),
        });
        return row === undefined ? undefined : toFundingTransaction(row);
      });
    },

    async sumInFlightAmountWeiByTreasury(treasuryId: string): Promise<bigint> {
      return withDatabaseErrors('funding_transactions.sumInFlightAmountWeiByTreasury', async () => {
        const rows = await db
          .select({ amountWei: fundingTransactions.amountWei })
          .from(fundingTransactions)
          .where(
            and(
              eq(fundingTransactions.treasuryId, treasuryId),
              inArray(fundingTransactions.status, IN_FLIGHT_STATUSES),
            ),
          );

        // Summed in bigint rather than SQL SUM(): the driver returns numeric
        // aggregates as strings or numbers depending on null-ness, and wei must
        // never round-trip through a float.
        return rows.reduce((total, row) => total + weiFromDatabaseNumeric(row.amountWei, 'amountWei'), 0n);
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

    async insertBroadcastIntent(input: InsertBroadcastIntentInput): Promise<FundingTransaction> {
      return withDatabaseErrors('funding_transactions.insertBroadcastIntent', async () => {
        // Non-terminal from insert: a crash after this commit and before / during
        // broadcast must keep the per-wallet duplicate gate closed (TX.10 / C4).
        const [row] = await db
          .insert(fundingTransactions)
          .values({
            id: input.id,
            operationId: input.operationId,
            treasuryId: input.treasuryId,
            managedWalletId: input.managedWalletId,
            amountWei: weiToDatabaseNumeric(input.amountWei, 'amountWei'),
            nonce: input.nonce,
            status: 'submission_unknown',
            errorCode: 'BROADCAST_INTENT',
            createdAt: input.createdAt,
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError(
            'DATABASE_UNAVAILABLE',
            'Funding transaction broadcast-intent insert returned no row',
          );
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

    async markSubmissionUnknown(
      id: string,
      input: { readonly nonce: number; readonly errorCode: string },
    ): Promise<FundingTransaction> {
      return transitionTransaction(db, id, 'submission_unknown', {
        nonce: input.nonce,
        errorCode: input.errorCode,
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

    async list(
      filter: FundingTransactionListFilter & { readonly scope: FundingTransactionScopeFilter },
      pagination: { readonly limit: number; readonly offset: number },
    ): Promise<FundingTransactionListPage> {
      return withDatabaseErrors('funding_transactions.list', async () => {
        const where = buildListWhere(filter);

        const [totalRow] = await db
          .select({ value: count() })
          .from(fundingTransactions)
          .innerJoin(fundingOperations, eq(fundingTransactions.operationId, fundingOperations.id))
          .innerJoin(managedWallets, eq(fundingTransactions.managedWalletId, managedWallets.id))
          .innerJoin(environments, eq(managedWallets.environmentId, environments.id))
          .innerJoin(projects, eq(environments.projectId, projects.id))
          .innerJoin(chains, eq(managedWallets.chainId, chains.id))
          .where(where);

        const rows = await db
          .select({
            tx: fundingTransactions,
            op: fundingOperations,
            wallet: managedWallets,
            environment: environments,
            project: projects,
            chain: chains,
          })
          .from(fundingTransactions)
          .innerJoin(fundingOperations, eq(fundingTransactions.operationId, fundingOperations.id))
          .innerJoin(managedWallets, eq(fundingTransactions.managedWalletId, managedWallets.id))
          .innerJoin(environments, eq(managedWallets.environmentId, environments.id))
          .innerJoin(projects, eq(environments.projectId, projects.id))
          .innerJoin(chains, eq(managedWallets.chainId, chains.id))
          .where(where)
          .orderBy(desc(fundingTransactions.createdAt), desc(fundingTransactions.id))
          .limit(pagination.limit)
          .offset(pagination.offset);

        return {
          items: rows.map(toFundingTransactionHistoryItem),
          total: Number(totalRow?.value ?? 0),
        };
      });
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

function toFundingTransactionHistoryItem(row: {
  readonly tx: FundingTransactionRow;
  readonly op: FundingOperationRow;
  readonly wallet: ManagedWalletRow;
  readonly environment: EnvironmentRow;
  readonly project: ProjectRow;
  readonly chain: ChainRow;
}): FundingTransactionHistoryItem {
  const addressDisplay = getAddress(row.wallet.address);
  return {
    id: row.tx.id,
    operationId: row.tx.operationId,
    amountWei: weiFromDatabaseNumeric(row.tx.amountWei, 'amountWei'),
    transactionHash: row.tx.transactionHash ?? undefined,
    nonce: row.tx.nonce ?? undefined,
    status: row.tx.status,
    errorCode: row.tx.errorCode ?? undefined,
    createdAt: row.tx.createdAt,
    submittedAt: row.tx.submittedAt ?? undefined,
    confirmedAt: row.tx.confirmedAt ?? undefined,
    operation: {
      id: row.op.id,
      operationType: row.op.operationType,
      status: row.op.status,
      requestedBy: row.op.requestedBy,
      startedAt: row.op.startedAt,
      completedAt: row.op.completedAt ?? undefined,
    },
    wallet: {
      id: row.wallet.id,
      role: row.wallet.role,
      address: row.wallet.address,
      addressDisplay,
    },
    project: {
      id: row.project.id,
      slug: row.project.slug,
      name: row.project.name,
      enabled: row.project.enabled,
    },
    environment: {
      id: row.environment.id,
      projectId: row.environment.projectId,
      slug: row.environment.slug,
      name: row.environment.name,
      enabled: row.environment.enabled,
    },
    chain: toChainDescriptor(row.chain),
  };
}

function buildListWhere(
  filter: FundingTransactionListFilter & { readonly scope: FundingTransactionScopeFilter },
): SQL | undefined {
  const clauses: SQL[] = [];

  if (filter.projectId !== undefined) {
    clauses.push(eq(environments.projectId, filter.projectId));
  }
  if (filter.environmentId !== undefined) {
    clauses.push(eq(environments.id, filter.environmentId));
  }
  if (filter.managedWalletId !== undefined) {
    clauses.push(eq(fundingTransactions.managedWalletId, filter.managedWalletId));
  }
  if (filter.status !== undefined) {
    clauses.push(eq(fundingTransactions.status, filter.status));
  }
  if (filter.createdFrom !== undefined) {
    clauses.push(gte(fundingTransactions.createdAt, filter.createdFrom));
  }
  if (filter.createdTo !== undefined) {
    clauses.push(lte(fundingTransactions.createdAt, filter.createdTo));
  }

  const scopeClause = buildScopeWhere(filter.scope);
  if (scopeClause !== undefined) {
    clauses.push(scopeClause);
  }

  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return clauses[0];
  }
  return and(...clauses);
}

function buildScopeWhere(scope: FundingTransactionScopeFilter): SQL | undefined {
  if (scope.kind === 'unrestricted') {
    return undefined;
  }
  if (scope.clauses === undefined || scope.clauses.length === 0) {
    return sql`false`;
  }

  const scopeClauses = scope.clauses.map((clause) => {
    if (clause.environmentId === undefined) {
      return eq(environments.projectId, clause.projectId);
    }
    return and(eq(environments.projectId, clause.projectId), eq(environments.id, clause.environmentId));
  });

  if (scopeClauses.length === 1) {
    return scopeClauses[0];
  }
  return or(...scopeClauses);
}
