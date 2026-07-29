import { and, eq } from 'drizzle-orm';
import type {
  FundingOperation,
  FundingOperationRepository,
  InsertFundingOperationInput,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import {
  canTransitionOperationStatus,
  type FundingOperationStatus,
} from '../../../domain/funding/statuses.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { fundingOperations, type FundingOperationRow } from '../schema.js';

export function createFundingOperationRepository(db: Database): FundingOperationRepository {
  return {
    async findById(id: string): Promise<FundingOperation | undefined> {
      return withDatabaseErrors('funding_operations.findById', async () => {
        const row = await db.query.fundingOperations.findFirst({
          where: eq(fundingOperations.id, id),
        });
        return row === undefined ? undefined : toFundingOperation(row);
      });
    },

    async findByIdempotencyKey(
      requestedBy: string,
      idempotencyKey: string,
    ): Promise<FundingOperation | undefined> {
      return withDatabaseErrors('funding_operations.findByIdempotencyKey', async () => {
        const row = await db.query.fundingOperations.findFirst({
          where: and(
            eq(fundingOperations.requestedBy, requestedBy),
            eq(fundingOperations.idempotencyKey, idempotencyKey),
          ),
        });
        return row === undefined ? undefined : toFundingOperation(row);
      });
    },

    async insertPending(input: InsertFundingOperationInput): Promise<FundingOperation> {
      return withDatabaseErrors('funding_operations.insertPending', async () => {
        const [row] = await db
          .insert(fundingOperations)
          .values({
            id: input.id,
            operationType: input.operationType,
            projectId: input.projectId ?? null,
            environmentId: input.environmentId ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            status: 'pending',
            requestedBy: input.requestedBy,
            startedAt: input.startedAt,
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Funding operation insert returned no row');
        }
        return toFundingOperation(row);
      });
    },

    async markInProgress(id: string): Promise<FundingOperation> {
      return transitionOperation(db, id, 'in_progress', {});
    },

    async markSucceeded(id: string, completedAt: Date): Promise<FundingOperation> {
      return transitionOperation(db, id, 'succeeded', { completedAt });
    },

    async markFailed(
      id: string,
      errorCode: string,
      errorSummary: string,
      completedAt: Date,
    ): Promise<FundingOperation> {
      return transitionOperation(db, id, 'failed', { errorCode, errorSummary, completedAt });
    },

    async markAbandoned(
      id: string,
      errorCode: string,
      errorSummary: string,
      completedAt: Date,
    ): Promise<FundingOperation> {
      return transitionOperation(db, id, 'abandoned', { errorCode, errorSummary, completedAt });
    },
  };
}

async function transitionOperation(
  db: Database,
  id: string,
  to: FundingOperationStatus,
  fields: {
    readonly completedAt?: Date;
    readonly errorCode?: string;
    readonly errorSummary?: string;
  },
): Promise<FundingOperation> {
  return withDatabaseErrors(`funding_operations.mark_${to}`, async () => {
    const existing = await db.query.fundingOperations.findFirst({
      where: eq(fundingOperations.id, id),
    });
    if (existing === undefined) {
      throw new ChainBankError('FUNDING_OPERATION_NOT_FOUND', `Funding operation ${id} was not found`);
    }

    const from = existing.status;
    if (!canTransitionOperationStatus(from, to)) {
      throw new ChainBankError(
        'INVALID_STATUS_TRANSITION',
        `Cannot transition funding operation from ${from} to ${to}`,
        {
          publicMessage: 'The funding operation cannot transition to that status.',
          context: { operationId: id, from, to },
        },
      );
    }

    const [row] = await db
      .update(fundingOperations)
      .set({
        status: to,
        completedAt: fields.completedAt ?? existing.completedAt,
        errorCode: fields.errorCode ?? existing.errorCode,
        errorSummary: fields.errorSummary ?? existing.errorSummary,
      })
      .where(eq(fundingOperations.id, id))
      .returning();

    if (row === undefined) {
      throw new ChainBankError('DATABASE_UNAVAILABLE', `Funding operation ${id} update returned no row`);
    }
    return toFundingOperation(row);
  });
}

function toFundingOperation(row: FundingOperationRow): FundingOperation {
  return {
    id: row.id,
    operationType: row.operationType,
    projectId: row.projectId ?? undefined,
    environmentId: row.environmentId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    status: row.status,
    requestedBy: row.requestedBy,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorSummary: row.errorSummary ?? undefined,
  };
}
