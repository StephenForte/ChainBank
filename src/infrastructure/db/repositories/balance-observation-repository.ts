import { and, desc, eq } from 'drizzle-orm';
import type {
  BalanceObservationInput,
  BalanceObservationRepository,
  BalanceObservationSummary,
} from '../../../app/ports.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { balanceObservations } from '../schema.js';

export function createBalanceObservationRepository(db: Database): BalanceObservationRepository {
  return {
    async record(input: BalanceObservationInput): Promise<void> {
      await withDatabaseErrors('balance_observations.record', async () => {
        await db.insert(balanceObservations).values({
          chainId: input.chainRowId,
          walletAddress: input.walletAddress,
          walletType: input.walletType,
          balanceWei: weiToDatabaseNumeric(input.balanceWei, 'balanceWei'),
          blockNumber: weiToDatabaseNumeric(input.blockNumber, 'blockNumber'),
          observedAt: input.observedAt,
          sourceOperationId: input.sourceOperationId ?? null,
        });
      });
    },

    async findLatest(
      chainRowId: string,
      walletAddress: string,
    ): Promise<BalanceObservationSummary | undefined> {
      return withDatabaseErrors('balance_observations.findLatest', async () => {
        const row = await db.query.balanceObservations.findFirst({
          where: and(
            eq(balanceObservations.chainId, chainRowId),
            eq(balanceObservations.walletAddress, walletAddress),
          ),
          orderBy: [desc(balanceObservations.observedAt)],
        });
        if (row === undefined) {
          return undefined;
        }
        return {
          balanceWei: weiFromDatabaseNumeric(row.balanceWei, 'balanceWei'),
          blockNumber: weiFromDatabaseNumeric(row.blockNumber, 'blockNumber'),
          observedAt: row.observedAt,
        };
      });
    },
  };
}
