import { eq, sql } from 'drizzle-orm';
import type {
  FundingPolicyRepository,
  FundingPolicyUpsertInput,
  StoredFundingPolicy,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { fundingPolicies, type FundingPolicyRow } from '../schema.js';

export function createFundingPolicyRepository(db: Database): FundingPolicyRepository {
  return {
    async upsert(input: FundingPolicyUpsertInput): Promise<StoredFundingPolicy> {
      return withDatabaseErrors('funding_policies.upsert', async () => {
        const minimum = weiToDatabaseNumeric(input.minimumBalanceWei, 'minimumBalanceWei');
        const target = weiToDatabaseNumeric(input.targetBalanceWei, 'targetBalanceWei');
        const maximum = weiToDatabaseNumeric(input.maximumTopUpWei, 'maximumTopUpWei');
        const now = new Date();

        const [row] = await db
          .insert(fundingPolicies)
          .values({
            managedWalletId: input.managedWalletId,
            minimumBalanceWei: minimum,
            targetBalanceWei: target,
            maximumTopUpWei: maximum,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: fundingPolicies.managedWalletId,
            set: {
              minimumBalanceWei: minimum,
              targetBalanceWei: target,
              maximumTopUpWei: maximum,
              // Version advances on every successful policy write.
              version: sql`${fundingPolicies.version} + 1`,
              updatedAt: now,
            },
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Funding policy upsert returned no row');
        }
        return toStoredFundingPolicy(row);
      });
    },

    async findByManagedWalletId(managedWalletId: string): Promise<StoredFundingPolicy | undefined> {
      return withDatabaseErrors('funding_policies.findByManagedWalletId', async () => {
        const row = await db.query.fundingPolicies.findFirst({
          where: eq(fundingPolicies.managedWalletId, managedWalletId),
        });
        return row === undefined ? undefined : toStoredFundingPolicy(row);
      });
    },
  };
}

export function toStoredFundingPolicy(row: FundingPolicyRow): StoredFundingPolicy {
  return {
    id: row.id,
    managedWalletId: row.managedWalletId,
    minimumBalanceWei: weiFromDatabaseNumeric(row.minimumBalanceWei, 'minimumBalanceWei'),
    targetBalanceWei: weiFromDatabaseNumeric(row.targetBalanceWei, 'targetBalanceWei'),
    maximumTopUpWei: weiFromDatabaseNumeric(row.maximumTopUpWei, 'maximumTopUpWei'),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
