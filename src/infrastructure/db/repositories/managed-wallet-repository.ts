import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { getAddress } from 'viem';
import type {
  EnvironmentSummary,
  ManagedWallet,
  ManagedWalletInsert,
  ManagedWalletListFilter,
  ManagedWalletListPage,
  ManagedWalletPatch,
  ManagedWalletRepository,
  ProjectSummary,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { isUniqueViolation, withDatabaseErrors, type Database } from '../client.js';
import {
  environments,
  managedWallets,
  type ChainRow,
  type EnvironmentRow,
  type FundingPolicyRow,
  type ManagedWalletRow,
  type ProjectRow,
} from '../schema.js';
import { toChainDescriptor } from './chain-repository.js';
import { toStoredFundingPolicy } from './funding-policy-repository.js';

type ManagedWalletLoaded = ManagedWalletRow & {
  environment: EnvironmentRow & { project: ProjectRow };
  chain: ChainRow;
  fundingPolicy: FundingPolicyRow | null | undefined;
};

export function createManagedWalletRepository(db: Database): ManagedWalletRepository {
  return {
    async insert(input: ManagedWalletInsert): Promise<ManagedWallet> {
      return withDatabaseErrors('managed_wallets.insert', async () => {
        try {
          const [row] = await db
            .insert(managedWallets)
            .values({
              environmentId: input.environmentId,
              chainId: input.chainRowId,
              role: input.role,
              address: input.address,
              criticalAtStartup: input.criticalAtStartup,
              reconciliationEnabled: input.reconciliationEnabled,
            })
            .returning({ id: managedWallets.id });

          if (row === undefined) {
            throw new ChainBankError('DATABASE_UNAVAILABLE', 'Managed wallet insert returned no row');
          }
          return loadById(db, row.id);
        } catch (error) {
          if (error instanceof ChainBankError) {
            throw error;
          }
          // Unique(chain_id, address) is the durable race guard for duplicate registration.
          if (isUniqueViolation(error)) {
            throw new ChainBankError(
              'WALLET_ALREADY_REGISTERED',
              `Managed wallet ${input.address} is already registered on this chain`,
              {
                publicMessage: 'A managed wallet with this chain and address is already registered.',
                context: { chainRowId: input.chainRowId, address: input.address },
                cause: error,
              },
            );
          }
          throw error;
        }
      });
    },

    async findById(id: string): Promise<ManagedWallet | undefined> {
      return withDatabaseErrors('managed_wallets.findById', async () => {
        const row = await db.query.managedWallets.findFirst({
          where: eq(managedWallets.id, id),
          with: {
            environment: { with: { project: true } },
            chain: true,
            fundingPolicy: true,
          },
        });
        return row === undefined ? undefined : toManagedWallet(row);
      });
    },

    async list(
      filter: ManagedWalletListFilter,
      pagination: { readonly limit: number; readonly offset: number },
    ): Promise<ManagedWalletListPage> {
      return withDatabaseErrors('managed_wallets.list', async () => {
        const where = buildListWhere(filter);

        const [totalRow] = await db
          .select({ value: count() })
          .from(managedWallets)
          .innerJoin(environments, eq(managedWallets.environmentId, environments.id))
          .where(where);

        const idRows = await db
          .select({ id: managedWallets.id })
          .from(managedWallets)
          .innerJoin(environments, eq(managedWallets.environmentId, environments.id))
          .where(where)
          .orderBy(asc(managedWallets.createdAt), asc(managedWallets.id))
          .limit(pagination.limit)
          .offset(pagination.offset);

        if (idRows.length === 0) {
          return { items: [], total: Number(totalRow?.value ?? 0) };
        }

        const rows = await db.query.managedWallets.findMany({
          where: inArray(
            managedWallets.id,
            idRows.map((row) => row.id),
          ),
          with: {
            environment: { with: { project: true } },
            chain: true,
            fundingPolicy: true,
          },
        });

        const byId = new Map(rows.map((row) => [row.id, toManagedWallet(row)]));
        const items = idRows.flatMap((row) => {
          const wallet = byId.get(row.id);
          return wallet === undefined ? [] : [wallet];
        });

        return {
          items,
          total: Number(totalRow?.value ?? 0),
        };
      });
    },

    async update(id: string, patch: ManagedWalletPatch): Promise<ManagedWallet> {
      return withDatabaseErrors('managed_wallets.update', async () => {
        const set: {
          enabled?: boolean;
          criticalAtStartup?: boolean;
          reconciliationEnabled?: boolean;
          updatedAt: Date;
        } = { updatedAt: new Date() };

        if (patch.enabled !== undefined) {
          set.enabled = patch.enabled;
        }
        if (patch.criticalAtStartup !== undefined) {
          set.criticalAtStartup = patch.criticalAtStartup;
        }
        if (patch.reconciliationEnabled !== undefined) {
          set.reconciliationEnabled = patch.reconciliationEnabled;
        }

        const [row] = await db
          .update(managedWallets)
          .set(set)
          .where(eq(managedWallets.id, id))
          .returning({ id: managedWallets.id });

        if (row === undefined) {
          throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${id} does not exist`);
        }
        return loadById(db, row.id);
      });
    },
  };
}

async function loadById(db: Database, id: string): Promise<ManagedWallet> {
  const row = await db.query.managedWallets.findFirst({
    where: eq(managedWallets.id, id),
    with: {
      environment: { with: { project: true } },
      chain: true,
      fundingPolicy: true,
    },
  });
  if (row === undefined) {
    throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${id} was not found after write`);
  }
  return toManagedWallet(row);
}

function buildListWhere(filter: ManagedWalletListFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.enabled !== undefined) {
    clauses.push(eq(managedWallets.enabled, filter.enabled));
  }
  if (filter.environmentId !== undefined) {
    clauses.push(eq(managedWallets.environmentId, filter.environmentId));
  }
  if (filter.projectId !== undefined) {
    clauses.push(eq(environments.projectId, filter.projectId));
  }
  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return clauses[0];
  }
  return and(...clauses);
}

function toManagedWallet(row: ManagedWalletLoaded): ManagedWallet {
  return {
    id: row.id,
    project: toProjectSummary(row.environment.project),
    environment: toEnvironmentSummary(row.environment),
    chain: toChainDescriptor(row.chain),
    role: row.role,
    address: row.address,
    // Stored form is lowercase; checksum for display at the boundary.
    addressDisplay: getAddress(row.address),
    enabled: row.enabled,
    criticalAtStartup: row.criticalAtStartup,
    reconciliationEnabled: row.reconciliationEnabled,
    policy:
      row.fundingPolicy === null || row.fundingPolicy === undefined
        ? undefined
        : toStoredFundingPolicy(row.fundingPolicy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
  };
}

function toEnvironmentSummary(row: EnvironmentRow): EnvironmentSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
  };
}
