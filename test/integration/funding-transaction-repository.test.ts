import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FUNDING_TRANSACTION_STATUSES } from '../../src/domain/funding/statuses.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { fundingOperations, fundingTransactions } from '../../src/infrastructure/db/schema.js';

describe.skipIf(!integrationEnabled)('funding transaction repository list', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let transactionIdsByStatus: Record<(typeof FUNDING_TRANSACTION_STATUSES)[number], string>;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);
    transactionIdsByStatus = await seedAllStatuses(handle, seed);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('lists all statuses newest first with joined context in one query path', async () => {
    const repository = createFundingTransactionRepository(handle.db);

    const page = await repository.list({ scope: { kind: 'unrestricted' } }, { limit: 50, offset: 0 });

    expect(page.total).toBe(FUNDING_TRANSACTION_STATUSES.length);
    expect(page.items).toHaveLength(FUNDING_TRANSACTION_STATUSES.length);

    for (const status of FUNDING_TRANSACTION_STATUSES) {
      expect(page.items.some((item) => item.status === status)).toBe(true);
    }

    expect(page.items[0]?.status).toBe('failed');
    expect(page.items.at(-1)?.status).toBe('created');

    const confirmed = page.items.find((item) => item.status === 'confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed?.project.id).toBe(seed.projectId);
    expect(confirmed?.environment.id).toBe(seed.environmentId);
    expect(confirmed?.wallet.id).toBe(seed.managedWalletId);
    expect(confirmed?.wallet.role).toBe('signer');
    expect(confirmed?.operation.requestedBy).toBe('cred-confirmed');
    expect(confirmed?.chain.explorerBaseUrl).toBe('https://sepolia.etherscan.io');
  });

  it('filters by project, environment, wallet, status, and date range', async () => {
    const repository = createFundingTransactionRepository(handle.db);
    const targetId = transactionIdsByStatus.confirmed;

    const byStatus = await repository.list(
      { scope: { kind: 'unrestricted' }, status: 'confirmed' },
      { limit: 50, offset: 0 },
    );
    expect(byStatus.total).toBe(1);
    expect(byStatus.items[0]?.id).toBe(targetId);

    const byProject = await repository.list(
      { scope: { kind: 'unrestricted' }, projectId: seed.projectId },
      { limit: 50, offset: 0 },
    );
    expect(byProject.total).toBe(FUNDING_TRANSACTION_STATUSES.length);

    const byEnvironment = await repository.list(
      { scope: { kind: 'unrestricted' }, environmentId: seed.environmentId },
      { limit: 50, offset: 0 },
    );
    expect(byEnvironment.total).toBe(FUNDING_TRANSACTION_STATUSES.length);

    const byWallet = await repository.list(
      { scope: { kind: 'unrestricted' }, managedWalletId: seed.managedWalletId },
      { limit: 50, offset: 0 },
    );
    expect(byWallet.total).toBe(FUNDING_TRANSACTION_STATUSES.length);

    // The seeder spaces rows one day apart by enum index, so derive the
    // confirmed row's day from the enum rather than hardcoding a date.
    const confirmedIndex = FUNDING_TRANSACTION_STATUSES.indexOf('confirmed');
    const confirmedDay = new Date(
      new Date('2026-06-01T00:00:00.000Z').getTime() + confirmedIndex * 86_400_000,
    );
    const byDate = await repository.list(
      {
        scope: { kind: 'unrestricted' },
        createdFrom: confirmedDay,
        createdTo: new Date(confirmedDay.getTime() + 86_400_000 - 1),
      },
      { limit: 50, offset: 0 },
    );
    expect(byDate.total).toBe(1);
    expect(byDate.items[0]?.status).toBe('confirmed');
  });

  it('paginates with a stable total count', async () => {
    const repository = createFundingTransactionRepository(handle.db);

    const firstPage = await repository.list({ scope: { kind: 'unrestricted' } }, { limit: 3, offset: 0 });
    const secondPage = await repository.list({ scope: { kind: 'unrestricted' } }, { limit: 3, offset: 3 });

    expect(firstPage.total).toBe(FUNDING_TRANSACTION_STATUSES.length);
    expect(secondPage.total).toBe(FUNDING_TRANSACTION_STATUSES.length);
    expect(firstPage.items).toHaveLength(3);
    expect(secondPage.items).toHaveLength(3);

    const firstIds = new Set(firstPage.items.map((item) => item.id));
    for (const item of secondPage.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  it('applies scoped project/environment constraints', async () => {
    const repository = createFundingTransactionRepository(handle.db);

    const scoped = await repository.list(
      {
        scope: {
          kind: 'scoped',
          clauses: [{ projectId: seed.projectId, environmentId: seed.environmentId }],
        },
      },
      { limit: 50, offset: 0 },
    );
    expect(scoped.total).toBe(FUNDING_TRANSACTION_STATUSES.length);

    const emptyScope = await repository.list(
      { scope: { kind: 'scoped', clauses: [] } },
      { limit: 50, offset: 0 },
    );
    expect(emptyScope.total).toBe(0);
    expect(emptyScope.items).toEqual([]);
  });
});

async function seedAllStatuses(
  handle: IntegrationDatabaseHandle,
  seed: Phase1Seed,
): Promise<Record<(typeof FUNDING_TRANSACTION_STATUSES)[number], string>> {
  const ids = {} as Record<(typeof FUNDING_TRANSACTION_STATUSES)[number], string>;
  const baseTime = new Date('2026-06-01T00:00:00.000Z').getTime();

  for (const [index, status] of FUNDING_TRANSACTION_STATUSES.entries()) {
    const [operation] = await handle.db
      .insert(fundingOperations)
      .values({
        operationType: 'ensure_funded',
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        requestedBy: `cred-${status}`,
        startedAt: new Date(baseTime + index * 60_000),
        status:
          status === 'failed' || status === 'dropped'
            ? 'failed'
            : status === 'replaced'
              ? 'abandoned'
              : 'succeeded',
        completedAt: new Date(baseTime + index * 60_000 + 30_000),
      })
      .returning({ id: fundingOperations.id });

    if (operation === undefined) {
      throw new Error(`Failed to seed operation for ${status}`);
    }

    const createdAt = new Date(baseTime + index * 86_400_000);
    const hasHash = status !== 'created' && status !== 'failed' && status !== 'submission_unknown';

    const [transaction] = await handle.db
      .insert(fundingTransactions)
      .values({
        operationId: operation.id,
        treasuryId: seed.treasuryId,
        managedWalletId: seed.managedWalletId,
        amountWei: String(1_000_000_000_000_000n * BigInt(index + 1)),
        status,
        transactionHash: hasHash ? `0x${String(index).padStart(64, '0')}` : null,
        nonce: status === 'created' ? null : index,
        errorCode: ['failed', 'reverted', 'replaced', 'dropped', 'submission_unknown'].includes(status)
          ? 'TEST_ERROR'
          : null,
        createdAt,
        submittedAt: status === 'created' ? null : new Date(createdAt.getTime() + 1_000),
        confirmedAt: status === 'confirmed' ? new Date(createdAt.getTime() + 5_000) : null,
      })
      .returning({ id: fundingTransactions.id });

    if (transaction === undefined) {
      throw new Error(`Failed to seed transaction for ${status}`);
    }

    ids[status] = transaction.id;
  }

  return ids;
}
