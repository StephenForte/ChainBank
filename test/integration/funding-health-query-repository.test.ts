import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFundingHealthQuery } from '../../src/infrastructure/db/repositories/funding-health-query-repository.js';
import { fundingOperations, fundingTransactions } from '../../src/infrastructure/db/schema.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

/**
 * CB-03 regression: coalesce(confirmed_at, submitted_at, created_at) returns a
 * Postgres text timestamptz through node-postgres. Unit suites that mock
 * WalletLastFundedRecord with a pre-built Date never exercise that mapping —
 * this test does, against a real row.
 */
describe.skipIf(!integrationEnabled)('funding health query repository', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('returns fundedAt as a Date whose ISO serialization matches the inserted instant', async () => {
    const confirmedAt = new Date('2026-08-08T18:00:39.000Z');
    const amountWei = '600000000000000000';
    const transactionHash = `0x${'ab'.repeat(32)}`;

    const [operation] = await handle.db
      .insert(fundingOperations)
      .values({
        operationType: 'ensure_funded',
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        requestedBy: 'cred-funding-health',
        status: 'succeeded',
        startedAt: new Date('2026-08-08T17:59:00.000Z'),
        completedAt: confirmedAt,
      })
      .returning({ id: fundingOperations.id });

    if (operation === undefined) {
      throw new Error('Failed to seed funding operation');
    }

    await handle.db.insert(fundingTransactions).values({
      operationId: operation.id,
      treasuryId: seed.treasuryId,
      managedWalletId: seed.managedWalletId,
      amountWei,
      status: 'confirmed',
      nonce: 1,
      transactionHash,
      createdAt: new Date('2026-08-08T17:59:30.000Z'),
      submittedAt: new Date('2026-08-08T17:59:45.000Z'),
      confirmedAt,
    });

    const query = createFundingHealthQuery(handle.db);
    const rows = await query.findLatestFundedByWalletIds([seed.managedWalletId]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }

    // The production crash was `fundedAt.toISOString is not a function` when
    // the driver handed back a string. Assert the runtime type, not only shape.
    expect(row.fundedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(row.fundedAt.getTime())).toBe(false);

    const lastFundedAt = row.fundedAt.toISOString();
    expect(lastFundedAt).toBe('2026-08-08T18:00:39.000Z');
    expect(lastFundedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(row.amountWei).toBe(600_000_000_000_000_000n);
    expect(row.transactionHash).toBe(transactionHash);
    expect(row.managedWalletId).toBe(seed.managedWalletId);
  });

  it('hydrates fundedAt from submittedAt when confirmedAt is null', async () => {
    const submittedAt = new Date('2026-08-08T11:00:39.000-07:00');
    const transactionHash = `0x${'cd'.repeat(32)}`;

    const [operation] = await handle.db
      .insert(fundingOperations)
      .values({
        operationType: 'ensure_funded',
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        requestedBy: 'cred-funding-health-submitted',
        status: 'succeeded',
        startedAt: submittedAt,
        completedAt: submittedAt,
      })
      .returning({ id: fundingOperations.id });

    if (operation === undefined) {
      throw new Error('Failed to seed funding operation');
    }

    await handle.db.insert(fundingTransactions).values({
      operationId: operation.id,
      treasuryId: seed.treasuryId,
      managedWalletId: seed.managedWalletId,
      amountWei: '1',
      status: 'submitted',
      nonce: 2,
      transactionHash,
      createdAt: submittedAt,
      submittedAt,
      confirmedAt: null,
    });

    const query = createFundingHealthQuery(handle.db);
    const [row] = await query.findLatestFundedByWalletIds([seed.managedWalletId]);

    expect(row?.fundedAt).toBeInstanceOf(Date);
    // new Date('2026-08-08 11:00:39-07') / offset form → same UTC instant.
    expect(row?.fundedAt.toISOString()).toBe('2026-08-08T18:00:39.000Z');
  });
});
