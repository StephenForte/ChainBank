import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { MIGRATIONS_FOLDER } from '../../src/infrastructure/db/migrate.js';
import {
  chains,
  environments,
  fundingOperations,
  managedWallets,
  projects,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';

export interface IntegrationDatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  applyMigrations(): Promise<void>;
  close(): Promise<void>;
}

export interface Phase1Seed {
  readonly chainId: string;
  readonly treasuryId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly managedWalletId: string;
  readonly operationId: string;
}

export function createIntegrationDatabase(): IntegrationDatabaseHandle {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required for integration database helpers');
  }

  const logger = createLogger({
    level: 'error',
    serviceRole: 'integration-test',
    environment: 'test',
  });
  const handle = createDatabase(
    { url: databaseUrl, useSsl: false, poolMax: 4, sslCertificateAuthority: undefined },
    logger,
  );

  return {
    db: handle.db,
    pool: handle.pool,
    async applyMigrations(): Promise<void> {
      await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    close: () => handle.close(),
  };
}

/** Removes Phase 1–3 rows so constraint tests start from a clean slate. */
export async function truncatePhase1Tables(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      alerts,
      funding_transactions,
      funding_operations,
      funding_policies,
      managed_wallets,
      api_credential_scopes,
      api_credentials,
      environments,
      projects,
      balance_observations,
      treasuries,
      chains
    RESTART IDENTITY CASCADE
  `);
}

export async function seedPhase1Fixtures(db: Database): Promise<Phase1Seed> {
  const [chain] = await db
    .insert(chains)
    .values({
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    })
    .returning({ id: chains.id });

  if (chain === undefined) {
    throw new Error('Failed to seed chain row');
  }

  const [treasury] = await db
    .insert(treasuries)
    .values({
      chainId: chain.id,
      address: '0x1111111111111111111111111111111111111111',
      addressDisplay: '0x1111111111111111111111111111111111111111',
      warningBalanceWei: '1000000000000000000',
      criticalBalanceWei: '250000000000000000',
      recoveryBalanceWei: '2000000000000000000',
      minimumReserveWei: '500000000000000000',
    })
    .returning({ id: treasuries.id });

  if (treasury === undefined) {
    throw new Error('Failed to seed treasury row');
  }

  const [project] = await db
    .insert(projects)
    .values({ slug: 'fortel2', name: 'ForteL2' })
    .returning({ id: projects.id });

  if (project === undefined) {
    throw new Error('Failed to seed project row');
  }

  const [environment] = await db
    .insert(environments)
    .values({ projectId: project.id, slug: 'dev', name: 'Development' })
    .returning({ id: environments.id });

  if (environment === undefined) {
    throw new Error('Failed to seed environment row');
  }

  const [managedWallet] = await db
    .insert(managedWallets)
    .values({
      environmentId: environment.id,
      chainId: chain.id,
      role: 'signer',
      address: '0x2222222222222222222222222222222222222222',
    })
    .returning({ id: managedWallets.id });

  if (managedWallet === undefined) {
    throw new Error('Failed to seed managed wallet row');
  }

  const [operation] = await db
    .insert(fundingOperations)
    .values({
      operationType: 'ensure_funded',
      projectId: project.id,
      environmentId: environment.id,
      requestedBy: 'cred-test',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: fundingOperations.id });

  if (operation === undefined) {
    throw new Error('Failed to seed funding operation row');
  }

  return {
    chainId: chain.id,
    treasuryId: treasury.id,
    projectId: project.id,
    environmentId: environment.id,
    managedWalletId: managedWallet.id,
    operationId: operation.id,
  };
}

export function isPgError(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object' && 'code' in current && Reflect.get(current, 'code') === code) {
      return true;
    }
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}
