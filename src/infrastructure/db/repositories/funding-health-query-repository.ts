import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  FundingHealthQuery,
  WalletFundingAttemptRecord,
  WalletLastFundedRecord,
} from '../../../app/ports.js';
import { weiFromDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { fundingOperations, fundingTransactions } from '../schema.js';

/**
 * Observability queries for GET /health/funding.
 *
 * Wallet linkage for blocked reconcile attempts (no funding_transactions row)
 * uses the durable idempotency key shape `reconcile:{runId}:{walletId}`.
 */
export function createFundingHealthQuery(db: Database): FundingHealthQuery {
  return {
    async findLatestFundedByWalletIds(
      managedWalletIds: readonly string[],
    ): Promise<readonly WalletLastFundedRecord[]> {
      return withDatabaseErrors('funding_health.findLatestFundedByWalletIds', async () => {
        if (managedWalletIds.length === 0) {
          return [];
        }

        const rows = await db
          .select({
            managedWalletId: fundingTransactions.managedWalletId,
            amountWei: fundingTransactions.amountWei,
            transactionHash: fundingTransactions.transactionHash,
            fundedAt:
              sql<Date>`coalesce(${fundingTransactions.confirmedAt}, ${fundingTransactions.submittedAt}, ${fundingTransactions.createdAt})`.as(
                'funded_at',
              ),
          })
          .from(fundingTransactions)
          .where(
            and(
              inArray(fundingTransactions.managedWalletId, [...managedWalletIds]),
              isNotNull(fundingTransactions.transactionHash),
              inArray(fundingTransactions.status, ['confirmed', 'submitted']),
            ),
          )
          .orderBy(
            fundingTransactions.managedWalletId,
            desc(
              sql`coalesce(${fundingTransactions.confirmedAt}, ${fundingTransactions.submittedAt}, ${fundingTransactions.createdAt})`,
            ),
          );

        const latest = new Map<string, WalletLastFundedRecord>();
        for (const row of rows) {
          if (latest.has(row.managedWalletId)) {
            continue;
          }
          if (row.transactionHash === null) {
            continue;
          }
          latest.set(row.managedWalletId, {
            managedWalletId: row.managedWalletId,
            fundedAt: row.fundedAt,
            amountWei: weiFromDatabaseNumeric(row.amountWei, 'amountWei'),
            transactionHash: row.transactionHash,
          });
        }
        return [...latest.values()];
      });
    },

    async findLatestReconcileAttemptsSince(
      managedWalletIds: readonly string[],
      since: Date,
    ): Promise<readonly WalletFundingAttemptRecord[]> {
      return withDatabaseErrors('funding_health.findLatestReconcileAttemptsSince', async () => {
        if (managedWalletIds.length === 0) {
          return [];
        }

        const walletIdSet = new Set(managedWalletIds);
        const rows = await db
          .select({
            idempotencyKey: fundingOperations.idempotencyKey,
            startedAt: fundingOperations.startedAt,
            operationStatus: fundingOperations.status,
            errorCode: fundingOperations.errorCode,
            amountWei: fundingTransactions.amountWei,
            transactionHash: fundingTransactions.transactionHash,
            transactionStatus: fundingTransactions.status,
          })
          .from(fundingOperations)
          .leftJoin(fundingTransactions, eq(fundingTransactions.operationId, fundingOperations.id))
          .where(
            and(
              gte(fundingOperations.startedAt, since),
              eq(fundingOperations.requestedBy, 'wallet-reconciler'),
              sql`${fundingOperations.idempotencyKey} like 'reconcile:%'`,
            ),
          )
          .orderBy(desc(fundingOperations.startedAt));

        const latest = new Map<string, WalletFundingAttemptRecord>();
        for (const row of rows) {
          const managedWalletId = parseReconcileWalletId(row.idempotencyKey);
          if (managedWalletId === undefined || !walletIdSet.has(managedWalletId)) {
            continue;
          }
          if (latest.has(managedWalletId)) {
            continue;
          }
          latest.set(managedWalletId, {
            managedWalletId,
            attemptedAt: row.startedAt,
            outcome: classifyAttemptOutcome({
              operationStatus: row.operationStatus,
              errorCode: row.errorCode,
              transactionStatus: row.transactionStatus,
            }),
            errorCode: row.errorCode ?? undefined,
            amountWei:
              row.amountWei === null ? undefined : weiFromDatabaseNumeric(row.amountWei, 'amountWei'),
            transactionHash: row.transactionHash ?? undefined,
          });
        }
        return [...latest.values()];
      });
    },
  };
}

function parseReconcileWalletId(idempotencyKey: string | null): string | undefined {
  if (idempotencyKey === null) {
    return undefined;
  }
  // reconcile:{runId}:{walletId} — runId/walletId are UUID-like opaque ids without ':'.
  const match = /^reconcile:([^:]+):([^:]+)$/.exec(idempotencyKey);
  return match?.[2];
}

function classifyAttemptOutcome(input: {
  readonly operationStatus: string;
  readonly errorCode: string | null;
  readonly transactionStatus: string | null;
}): WalletFundingAttemptRecord['outcome'] {
  if (input.errorCode === 'FUNDING_BLOCKED_RESERVE') {
    return 'blocked';
  }
  if (input.transactionStatus === 'confirmed' || input.transactionStatus === 'submitted') {
    return 'succeeded';
  }
  if (
    input.transactionStatus === 'reverted' ||
    input.transactionStatus === 'replaced' ||
    input.transactionStatus === 'dropped' ||
    input.transactionStatus === 'failed'
  ) {
    return 'failed';
  }
  if (input.operationStatus === 'failed' || input.operationStatus === 'abandoned') {
    return input.errorCode === 'FUNDING_DISABLED' ? 'blocked' : 'failed';
  }
  if (input.operationStatus === 'succeeded') {
    return 'succeeded';
  }
  return 'pending';
}
