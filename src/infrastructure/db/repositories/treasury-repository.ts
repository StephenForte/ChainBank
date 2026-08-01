import { and, eq } from 'drizzle-orm';
import type {
  RecordCheckFailureInput,
  RecordCheckSuccessInput,
  Treasury,
  TreasuryRegistration,
  TreasuryRepository,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { weiFromDatabaseNumeric, weiToDatabaseNumeric } from '../../../domain/wei.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { treasuries, type ChainRow, type TreasuryRow } from '../schema.js';
import { toChainDescriptor } from './chain-repository.js';

type TreasuryWithChain = TreasuryRow & { chain: ChainRow };

export function createTreasuryRepository(db: Database): TreasuryRepository {
  async function loadById(id: string): Promise<Treasury> {
    const row = await db.query.treasuries.findFirst({
      where: eq(treasuries.id, id),
      with: { chain: true },
    });
    if (row === undefined) {
      throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${id} was not found after write`);
    }
    return toTreasury(row);
  }

  return {
    async upsert(registration: TreasuryRegistration): Promise<Treasury> {
      return withDatabaseErrors('treasuries.upsert', async () => {
        const [row] = await db
          .insert(treasuries)
          .values({
            chainId: registration.chainRowId,
            address: registration.address,
            addressDisplay: registration.addressDisplay,
            warningBalanceWei: weiToDatabaseNumeric(
              registration.thresholds.warningBalanceWei,
              'warningBalanceWei',
            ),
            criticalBalanceWei: weiToDatabaseNumeric(
              registration.thresholds.criticalBalanceWei,
              'criticalBalanceWei',
            ),
            recoveryBalanceWei: weiToDatabaseNumeric(
              registration.thresholds.recoveryBalanceWei,
              'recoveryBalanceWei',
            ),
            minimumReserveWei: weiToDatabaseNumeric(
              registration.thresholds.minimumReserveWei,
              'minimumReserveWei',
            ),
          })
          .onConflictDoUpdate({
            target: [treasuries.chainId, treasuries.address],
            set: {
              addressDisplay: registration.addressDisplay,
              warningBalanceWei: weiToDatabaseNumeric(
                registration.thresholds.warningBalanceWei,
                'warningBalanceWei',
              ),
              criticalBalanceWei: weiToDatabaseNumeric(
                registration.thresholds.criticalBalanceWei,
                'criticalBalanceWei',
              ),
              recoveryBalanceWei: weiToDatabaseNumeric(
                registration.thresholds.recoveryBalanceWei,
                'recoveryBalanceWei',
              ),
              minimumReserveWei: weiToDatabaseNumeric(
                registration.thresholds.minimumReserveWei,
                'minimumReserveWei',
              ),
              updatedAt: new Date(),
            },
          })
          .returning({ id: treasuries.id });

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Treasury upsert returned no row');
        }
        return loadById(row.id);
      });
    },

    async findById(id: string): Promise<Treasury | undefined> {
      return withDatabaseErrors('treasuries.findById', async () => {
        const row = await db.query.treasuries.findFirst({
          where: eq(treasuries.id, id),
          with: { chain: true },
        });
        return row === undefined ? undefined : toTreasury(row);
      });
    },

    async listEnabled(): Promise<readonly Treasury[]> {
      return withDatabaseErrors('treasuries.listEnabled', async () => {
        const rows = await db.query.treasuries.findMany({
          where: eq(treasuries.enabled, true),
          with: { chain: true },
          orderBy: (table, { asc }) => [asc(table.createdAt)],
        });
        return rows.map(toTreasury);
      });
    },

    async setEnabled(id: string, enabled: boolean): Promise<Treasury> {
      return withDatabaseErrors('treasuries.setEnabled', async () => {
        const [row] = await db
          .update(treasuries)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(treasuries.id, id))
          .returning({ id: treasuries.id });

        if (row === undefined) {
          throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${id} was not found`);
        }
        return loadById(row.id);
      });
    },

    async recordCheckSuccess(input: RecordCheckSuccessInput): Promise<Treasury> {
      return withDatabaseErrors('treasuries.recordCheckSuccess', async () => {
        await db
          .update(treasuries)
          .set({
            status: input.status,
            lastObservedBalanceWei: weiToDatabaseNumeric(input.balanceWei, 'balanceWei'),
            lastObservedAt: input.observedAt,
            lastCheckedAt: input.observedAt,
            lastCheckErrorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(treasuries.id, input.treasuryId));
        return loadById(input.treasuryId);
      });
    },

    async recordCheckFailure(input: RecordCheckFailureInput): Promise<Treasury> {
      return withDatabaseErrors('treasuries.recordCheckFailure', async () => {
        // The previously observed balance is intentionally preserved: it is the
        // last thing known to be true, and overwriting it would manufacture a
        // zero balance out of a provider outage.
        await db
          .update(treasuries)
          .set({
            status: 'unknown',
            lastCheckedAt: input.checkedAt,
            lastCheckErrorCode: input.errorCode,
            updatedAt: new Date(),
          })
          .where(eq(treasuries.id, input.treasuryId));
        return loadById(input.treasuryId);
      });
    },
  };
}

export async function findTreasuryByAddress(
  db: Database,
  chainRowId: string,
  address: string,
): Promise<Treasury | undefined> {
  const row = await withDatabaseErrors('treasuries.findByAddress', () =>
    db.query.treasuries.findFirst({
      where: and(eq(treasuries.chainId, chainRowId), eq(treasuries.address, address)),
      with: { chain: true },
    }),
  );
  return row === undefined ? undefined : toTreasury(row);
}

function toTreasury(row: TreasuryWithChain): Treasury {
  return {
    id: row.id,
    chain: toChainDescriptor(row.chain),
    address: row.address,
    addressDisplay: row.addressDisplay,
    thresholds: {
      warningBalanceWei: weiFromDatabaseNumeric(row.warningBalanceWei, 'warningBalanceWei'),
      criticalBalanceWei: weiFromDatabaseNumeric(row.criticalBalanceWei, 'criticalBalanceWei'),
      recoveryBalanceWei: weiFromDatabaseNumeric(row.recoveryBalanceWei, 'recoveryBalanceWei'),
      minimumReserveWei: weiFromDatabaseNumeric(row.minimumReserveWei, 'minimumReserveWei'),
    },
    status: row.status,
    lastObservedBalanceWei:
      row.lastObservedBalanceWei === null
        ? undefined
        : weiFromDatabaseNumeric(row.lastObservedBalanceWei, 'lastObservedBalanceWei'),
    lastObservedAt: row.lastObservedAt ?? undefined,
    lastCheckedAt: row.lastCheckedAt ?? undefined,
    lastCheckErrorCode: row.lastCheckErrorCode ?? undefined,
    enabled: row.enabled,
  };
}
