import { count, desc, eq, isNotNull } from 'drizzle-orm';
import type {
  FinishReconciliationRunInput,
  InsertReconciliationRunInput,
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationRunListPage,
  ReconciliationRunRepository,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { reconciliationRuns, type ReconciliationRunRow } from '../schema.js';

export function createReconciliationRunRepository(db: Database): ReconciliationRunRepository {
  return {
    async insertStarted(input: InsertReconciliationRunInput): Promise<ReconciliationRun> {
      return withDatabaseErrors('reconciliation_runs.insertStarted', async () => {
        const [row] = await db
          .insert(reconciliationRuns)
          .values({
            id: input.id,
            runId: input.runId,
            requestedBy: input.requestedBy,
            startedAt: input.startedAt,
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Reconciliation run insert returned no row');
        }
        return toReconciliationRun(row);
      });
    },

    async markFinished(input: FinishReconciliationRunInput): Promise<ReconciliationRun> {
      return withDatabaseErrors('reconciliation_runs.markFinished', async () => {
        const [row] = await db
          .update(reconciliationRuns)
          .set({
            finishedAt: input.finishedAt,
            walletsAssessed: input.walletsAssessed,
            walletsFunded: input.walletsFunded,
            walletsNoop: input.walletsNoop,
            walletsBlocked: input.walletsBlocked,
            walletsFailed: input.walletsFailed,
            weiTransferred: weiToDatabaseNumeric(input.weiTransferred, 'weiTransferred'),
            submissionUnknownResolved: input.submissionUnknownResolved,
            submissionUnknownLeftPending: input.submissionUnknownLeftPending,
            unexplainedTransferCount: input.unexplainedTransferCount,
            outgoingScanStatus: input.outgoingScanStatus,
            findingsJson: input.findings,
            errorCode: input.errorCode,
            errorSummary: input.errorSummary,
          })
          .where(eq(reconciliationRuns.id, input.id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError(
            'DATABASE_UNAVAILABLE',
            `Reconciliation run ${input.id} was not found for finish`,
          );
        }
        return toReconciliationRun(row);
      });
    },

    async findById(id: string): Promise<ReconciliationRun | undefined> {
      return withDatabaseErrors('reconciliation_runs.findById', async () => {
        const row = await db.query.reconciliationRuns.findFirst({
          where: eq(reconciliationRuns.id, id),
        });
        return row === undefined ? undefined : toReconciliationRun(row);
      });
    },

    async listRecent(limit: number): Promise<readonly ReconciliationRun[]> {
      return withDatabaseErrors('reconciliation_runs.listRecent', async () => {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new ChainBankError(
            'INVALID_REQUEST',
            `listRecent limit must be a positive integer; got ${String(limit)}`,
          );
        }
        const rows = await db
          .select()
          .from(reconciliationRuns)
          .orderBy(desc(reconciliationRuns.startedAt))
          .limit(limit);
        return rows.map(toReconciliationRun);
      });
    },

    async findLatestFinished(): Promise<ReconciliationRun | undefined> {
      return withDatabaseErrors('reconciliation_runs.findLatestFinished', async () => {
        const rows = await db
          .select()
          .from(reconciliationRuns)
          .where(isNotNull(reconciliationRuns.finishedAt))
          .orderBy(desc(reconciliationRuns.finishedAt))
          .limit(1);
        const row = rows[0];
        return row === undefined ? undefined : toReconciliationRun(row);
      });
    },

    async list(pagination: {
      readonly limit: number;
      readonly offset: number;
    }): Promise<ReconciliationRunListPage> {
      return withDatabaseErrors('reconciliation_runs.list', async () => {
        if (!Number.isInteger(pagination.limit) || pagination.limit < 1) {
          throw new ChainBankError(
            'INVALID_REQUEST',
            `list limit must be a positive integer; got ${String(pagination.limit)}`,
          );
        }
        if (!Number.isInteger(pagination.offset) || pagination.offset < 0) {
          throw new ChainBankError(
            'INVALID_REQUEST',
            `list offset must be a non-negative integer; got ${String(pagination.offset)}`,
          );
        }

        const [totalRow] = await db.select({ value: count() }).from(reconciliationRuns);
        const rows = await db
          .select()
          .from(reconciliationRuns)
          .orderBy(desc(reconciliationRuns.startedAt))
          .limit(pagination.limit)
          .offset(pagination.offset);

        return {
          items: rows.map(toReconciliationRun),
          total: Number(totalRow?.value ?? 0),
        };
      });
    },

    async count(): Promise<number> {
      return withDatabaseErrors('reconciliation_runs.count', async () => {
        const [totalRow] = await db.select({ value: count() }).from(reconciliationRuns);
        return Number(totalRow?.value ?? 0);
      });
    },
  };
}

function toReconciliationRun(row: ReconciliationRunRow): ReconciliationRun {
  const scanStatus = row.outgoingScanStatus;
  if (scanStatus !== 'complete' && scanStatus !== 'incomplete' && scanStatus !== 'not-run') {
    throw new ChainBankError(
      'INTERNAL_ERROR',
      `Invalid reconciliation_runs.outgoing_scan_status: ${scanStatus}`,
    );
  }

  return {
    id: row.id,
    runId: row.runId,
    requestedBy: row.requestedBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    walletsAssessed: row.walletsAssessed,
    walletsFunded: row.walletsFunded,
    walletsNoop: row.walletsNoop,
    walletsBlocked: row.walletsBlocked,
    walletsFailed: row.walletsFailed,
    weiTransferred: weiFromDatabaseNumeric(row.weiTransferred, 'weiTransferred'),
    submissionUnknownResolved: row.submissionUnknownResolved,
    submissionUnknownLeftPending: row.submissionUnknownLeftPending,
    unexplainedTransferCount: row.unexplainedTransferCount,
    outgoingScanStatus: scanStatus,
    findings: parseFindings(row.findingsJson),
    errorCode: row.errorCode ?? undefined,
    errorSummary: row.errorSummary ?? undefined,
  };
}

function parseFindings(value: unknown): readonly ReconciliationFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as readonly ReconciliationFinding[];
}
