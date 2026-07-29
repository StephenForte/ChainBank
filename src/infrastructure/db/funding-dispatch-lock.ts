import { sql } from 'drizzle-orm';
import type { FundingDispatchLock, FundingDispatchUnitOfWork } from '../../app/ports.js';
import { fundingAdvisoryLockKey } from '../../domain/funding/advisory-lock-key.js';
import { withDatabaseErrors, type Database } from './client.js';
import { createFundingOperationRepository } from './repositories/funding-operation-repository.js';
import { createFundingTransactionRepository } from './repositories/funding-transaction-repository.js';

/**
 * Postgres advisory-lock unit of work for funding dispatch (decision D7).
 *
 * The lock is transaction-scoped (`pg_advisory_xact_lock`) and held for the
 * entire callback, including RPC signing, so nonce allocation stays serialized
 * per treasury/chain. Database unavailability prevents the callback (and thus
 * signing) from running.
 */
export function createFundingDispatchLock(db: Database): FundingDispatchLock {
  return {
    async runExclusive<T>(
      treasuryId: string,
      evmChainId: number,
      work: (uow: FundingDispatchUnitOfWork) => Promise<T>,
    ): Promise<T> {
      const key = fundingAdvisoryLockKey(treasuryId, evmChainId);

      return withDatabaseErrors('funding.advisoryLock', () =>
        db.transaction(async (tx) => {
          // hashtext(treasury UUID) + EVM chain id → int4 pair for advisory lock.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key.treasuryId}), ${key.evmChainId})`);

          // Drizzle's transaction client exposes the same query API as Database.
          const txDb: Database = tx;
          const uow: FundingDispatchUnitOfWork = {
            operations: createFundingOperationRepository(txDb),
            transactions: createFundingTransactionRepository(txDb),
          };
          return work(uow);
        }),
      );
    },
  };
}
