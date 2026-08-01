import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDatabase, type Database } from '../../src/infrastructure/db/client.js';
import { MIGRATIONS_FOLDER } from '../../src/infrastructure/db/migrate.js';
import {
  chains,
  environments,
  fundingOperations,
  fundingPolicies,
  fundingTransactions,
  managedWallets,
  projects,
  treasuries,
} from '../../src/infrastructure/db/schema.js';
import type { FundingTransactionStatus } from '../../src/domain/funding/statuses.js';
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

export interface CreateIntegrationDatabaseOptions {
  /** Override pool size for concurrency tests that hold multiple advisory-lock connections. */
  readonly poolMax?: number;
}

export function createIntegrationDatabase(
  options: CreateIntegrationDatabaseOptions = {},
): IntegrationDatabaseHandle {
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
    {
      url: databaseUrl,
      useSsl: false,
      poolMax: options.poolMax ?? 4,
      sslCertificateAuthority: undefined,
    },
    logger,
  );

  // Checked-out clients emit 'error' when a crash-recovery test calls
  // pg_terminate_backend; without a listener Node treats that as uncaught.
  handle.pool.on('connect', (client) => {
    client.on('error', () => {
      // expected for deliberately terminated backends in integration tests
    });
  });

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
      minimumReserveWei: '100000000000000000',
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

export interface SeedManagedWalletInput {
  readonly environmentId: string;
  readonly chainId: string;
  readonly address: string;
  readonly role?: 'signer' | 'relayer' | 'other';
  readonly policy?: {
    readonly minimumBalanceWei: string;
    readonly targetBalanceWei: string;
    readonly maximumTopUpWei: string;
  };
}

/** Inserts an additional managed wallet (and optional policy) for multi-wallet concurrency fixtures. */
export async function seedManagedWallet(
  db: Database,
  input: SeedManagedWalletInput,
): Promise<{ readonly id: string; readonly address: string }> {
  const [wallet] = await db
    .insert(managedWallets)
    .values({
      environmentId: input.environmentId,
      chainId: input.chainId,
      role: input.role ?? 'relayer',
      address: input.address.toLowerCase(),
    })
    .returning({ id: managedWallets.id, address: managedWallets.address });

  if (wallet === undefined) {
    throw new Error('Failed to seed managed wallet');
  }

  if (input.policy !== undefined) {
    await db.insert(fundingPolicies).values({
      managedWalletId: wallet.id,
      minimumBalanceWei: input.policy.minimumBalanceWei,
      targetBalanceWei: input.policy.targetBalanceWei,
      maximumTopUpWei: input.policy.maximumTopUpWei,
      version: 1,
    });
  }

  return wallet;
}

export interface SeedInFlightFundingTransactionInput {
  readonly projectId: string;
  readonly environmentId: string;
  readonly treasuryId: string;
  readonly managedWalletId: string;
  readonly amountWei: string;
  readonly status: Extract<FundingTransactionStatus, 'created' | 'submitted' | 'submission_unknown'>;
  readonly requestedBy?: string;
  readonly nonce?: number;
  readonly transactionHash?: string;
  readonly errorCode?: string;
  readonly createdAt?: Date;
}

/**
 * Seeds an in-flight funding_transactions row (C4: created | submitted | submission_unknown)
 * with a parent funding_operations row, for pending-tx gate tests.
 */
export async function seedInFlightFundingTransaction(
  db: Database,
  input: SeedInFlightFundingTransactionInput,
): Promise<{ readonly operationId: string; readonly transactionId: string }> {
  const createdAt = input.createdAt ?? new Date('2026-07-29T12:00:00.000Z');
  const [operation] = await db
    .insert(fundingOperations)
    .values({
      operationType: 'ensure_funded',
      projectId: input.projectId,
      environmentId: input.environmentId,
      requestedBy: input.requestedBy ?? 'cred-inflight-seed',
      status: 'in_progress',
      startedAt: createdAt,
    })
    .returning({ id: fundingOperations.id });

  if (operation === undefined) {
    throw new Error('Failed to seed in-flight funding operation');
  }

  const [transaction] = await db
    .insert(fundingTransactions)
    .values({
      operationId: operation.id,
      treasuryId: input.treasuryId,
      managedWalletId: input.managedWalletId,
      amountWei: input.amountWei,
      status: input.status,
      nonce: input.nonce ?? (input.status === 'created' ? null : 1),
      transactionHash:
        input.transactionHash ?? (input.status === 'submitted' ? `0x${'cd'.repeat(32)}` : null),
      errorCode: input.errorCode ?? (input.status === 'submission_unknown' ? 'RPC_UNAVAILABLE' : null),
      createdAt,
      submittedAt: input.status === 'submitted' ? createdAt : null,
    })
    .returning({ id: fundingTransactions.id });

  if (transaction === undefined) {
    throw new Error('Failed to seed in-flight funding transaction');
  }

  return { operationId: operation.id, transactionId: transaction.id };
}

/**
 * Returns backend PIDs currently holding a granted Postgres advisory lock.
 * Used by crash-recovery tests to terminate the connection mid-dispatch.
 */
export async function listGrantedAdvisoryLockPids(pool: pg.Pool): Promise<readonly number[]> {
  const result = await pool.query<{ pid: number }>(
    `SELECT DISTINCT pid
     FROM pg_locks
     WHERE locktype = 'advisory' AND granted = true AND pid IS NOT NULL`,
  );
  return result.rows.map((row) => row.pid);
}

/** Count of backends blocked waiting to acquire a Postgres advisory lock. */
export async function countWaitingAdvisoryLockBackends(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pg_locks
     WHERE locktype = 'advisory' AND granted = false`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Resolves when at least `minimum` backends are waiting on an advisory lock.
 * Deterministic alternative to sleep-based barriers for concurrency tests.
 */
export async function waitForAdvisoryLockWaiters(
  pool: pg.Pool,
  minimum: number,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await countWaitingAdvisoryLockBackends(pool);
    if (waiting >= minimum) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${String(minimum)} advisory-lock waiters (saw ${String(waiting)})`,
      );
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
