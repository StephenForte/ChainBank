import { eq } from 'drizzle-orm';
import type { ChainDescriptor, ChainRegistration, ChainRepository } from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { chains, type ChainRow } from '../schema.js';

export function createChainRepository(db: Database): ChainRepository {
  return {
    async upsert(registration: ChainRegistration): Promise<ChainDescriptor> {
      return withDatabaseErrors('chains.upsert', async () => {
        const [row] = await db
          .insert(chains)
          .values({
            slug: registration.slug,
            chainId: registration.chainId,
            displayName: registration.displayName,
            nativeSymbol: registration.nativeSymbol,
            explorerBaseUrl: registration.explorerBaseUrl,
          })
          .onConflictDoUpdate({
            target: chains.chainId,
            set: {
              slug: registration.slug,
              displayName: registration.displayName,
              nativeSymbol: registration.nativeSymbol,
              explorerBaseUrl: registration.explorerBaseUrl,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Chain upsert returned no row');
        }
        return toChainDescriptor(row);
      });
    },

    async findByNumericChainId(chainId: number): Promise<ChainDescriptor | undefined> {
      return withDatabaseErrors('chains.findByNumericChainId', async () => {
        const row = await db.query.chains.findFirst({ where: eq(chains.chainId, chainId) });
        return row === undefined ? undefined : toChainDescriptor(row);
      });
    },
  };
}

export async function requireChainByChainId(db: Database, chainId: number): Promise<ChainDescriptor> {
  const row = await withDatabaseErrors('chains.findByChainId', () =>
    db.query.chains.findFirst({ where: eq(chains.chainId, chainId) }),
  );
  if (row === undefined) {
    throw new ChainBankError('CHAIN_NOT_FOUND', `Chain ${String(chainId)} is not registered`);
  }
  return toChainDescriptor(row);
}

export function toChainDescriptor(row: ChainRow): ChainDescriptor {
  return {
    id: row.id,
    slug: row.slug,
    chainId: row.chainId,
    displayName: row.displayName,
    nativeSymbol: row.nativeSymbol,
    explorerBaseUrl: row.explorerBaseUrl,
  };
}
