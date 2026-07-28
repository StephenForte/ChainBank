import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alerts,
  environments,
  fundingOperations,
  fundingPolicies,
  fundingTransactions,
  managedWallets,
  projects,
} from '../../src/infrastructure/db/schema.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  isPgError,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

describe.skipIf(!integrationEnabled)('Phase 1 schema constraints', () => {
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

  describe('unique constraints', () => {
    it('rejects duplicate project slugs', async () => {
      await expect(
        handle.db.insert(projects).values({ slug: 'fortel2', name: 'Duplicate' }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
    });

    it('rejects duplicate environment slugs within a project', async () => {
      await expect(
        handle.db.insert(environments).values({
          projectId: seed.projectId,
          slug: 'dev',
          name: 'Duplicate Dev',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
    });

    it('allows the same environment slug under different projects', async () => {
      const [otherProject] = await handle.db
        .insert(projects)
        .values({ slug: 'other-project', name: 'Other' })
        .returning({ id: projects.id });

      if (otherProject === undefined) {
        throw new Error('Expected project row');
      }

      await expect(
        handle.db.insert(environments).values({
          projectId: otherProject.id,
          slug: 'dev',
          name: 'Other Dev',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects duplicate managed wallet addresses on the same chain', async () => {
      await expect(
        handle.db.insert(managedWallets).values({
          environmentId: seed.environmentId,
          chainId: seed.chainId,
          role: 'other',
          address: '0x2222222222222222222222222222222222222222',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
    });

    it('rejects a second funding policy for the same managed wallet', async () => {
      await handle.db.insert(fundingPolicies).values({
        managedWalletId: seed.managedWalletId,
        minimumBalanceWei: '100000000000000000',
        targetBalanceWei: '200000000000000000',
        maximumTopUpWei: '500000000000000000',
        version: 1,
      });

      await expect(
        handle.db.insert(fundingPolicies).values({
          managedWalletId: seed.managedWalletId,
          minimumBalanceWei: '100000000000000000',
          targetBalanceWei: '200000000000000000',
          maximumTopUpWei: '500000000000000000',
          version: 2,
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
    });

    it('rejects duplicate idempotency keys for the same requester when the key is set', async () => {
      const startedAt = new Date('2026-01-02T00:00:00.000Z');

      await handle.db.insert(fundingOperations).values({
        operationType: 'ensure_funded',
        requestedBy: 'cred-a',
        idempotencyKey: 'idem-1',
        startedAt,
      });

      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_funded',
          requestedBy: 'cred-a',
          idempotencyKey: 'idem-1',
          startedAt,
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
    });

    it('allows multiple operations with null idempotency keys for the same requester', async () => {
      const startedAt = new Date('2026-01-02T00:00:00.000Z');

      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_funded',
          requestedBy: 'cred-a',
          startedAt,
        }),
      ).resolves.toBeDefined();

      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_funded',
          requestedBy: 'cred-a',
          startedAt,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('foreign keys', () => {
    it('rejects environments referencing a missing project', async () => {
      await expect(
        handle.db.insert(environments).values({
          projectId: randomUUID(),
          slug: 'staging',
          name: 'Staging',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });

    it('rejects managed wallets referencing missing environment or chain rows', async () => {
      await expect(
        handle.db.insert(managedWallets).values({
          environmentId: randomUUID(),
          chainId: seed.chainId,
          role: 'signer',
          address: '0x3333333333333333333333333333333333333333',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

      await expect(
        handle.db.insert(managedWallets).values({
          environmentId: seed.environmentId,
          chainId: randomUUID(),
          role: 'signer',
          address: '0x4444444444444444444444444444444444444444',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });

    it('rejects funding policies referencing a missing managed wallet', async () => {
      await expect(
        handle.db.insert(fundingPolicies).values({
          managedWalletId: randomUUID(),
          minimumBalanceWei: '100000000000000000',
          targetBalanceWei: '200000000000000000',
          maximumTopUpWei: '500000000000000000',
          version: 1,
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });

    it('rejects funding operations referencing missing project or environment rows', async () => {
      const startedAt = new Date('2026-01-03T00:00:00.000Z');

      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_ready',
          projectId: randomUUID(),
          requestedBy: 'cred-b',
          startedAt,
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_ready',
          environmentId: randomUUID(),
          requestedBy: 'cred-b',
          startedAt,
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });

    it('rejects funding transactions referencing missing parent rows', async () => {
      await expect(
        handle.db.insert(fundingTransactions).values({
          operationId: randomUUID(),
          treasuryId: seed.treasuryId,
          managedWalletId: seed.managedWalletId,
          amountWei: '100000000000000000',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

      await expect(
        handle.db.insert(fundingTransactions).values({
          operationId: seed.operationId,
          treasuryId: randomUUID(),
          managedWalletId: seed.managedWalletId,
          amountWei: '100000000000000000',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

      await expect(
        handle.db.insert(fundingTransactions).values({
          operationId: seed.operationId,
          treasuryId: seed.treasuryId,
          managedWalletId: randomUUID(),
          amountWei: '100000000000000000',
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });
  });

  describe('status enums (contract C4)', () => {
    it('accepts valid funding operation and transaction statuses', async () => {
      const [operation] = await handle.db
        .insert(fundingOperations)
        .values({
          operationType: 'ensure_funded',
          requestedBy: 'cred-status',
          status: 'in_progress',
          startedAt: new Date('2026-01-04T00:00:00.000Z'),
        })
        .returning({ id: fundingOperations.id });

      if (operation === undefined) {
        throw new Error('Expected funding operation row');
      }

      await expect(
        handle.db.insert(fundingTransactions).values({
          operationId: operation.id,
          treasuryId: seed.treasuryId,
          managedWalletId: seed.managedWalletId,
          amountWei: '100000000000000000',
          status: 'submitted',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects invalid funding operation status values', async () => {
      await expect(
        handle.db.insert(fundingOperations).values({
          operationType: 'ensure_funded',
          requestedBy: 'cred-invalid',
          status: 'completed' as 'pending',
          startedAt: new Date('2026-01-05T00:00:00.000Z'),
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '22P02'));
    });
  });

  describe('alerts table', () => {
    it('persists alert rows without foreign keys', async () => {
      const now = new Date('2026-01-06T00:00:00.000Z');

      await expect(
        handle.db.insert(alerts).values({
          alertType: 'treasury_warning',
          severity: 'warning',
          entityType: 'treasury',
          entityId: seed.treasuryId,
          state: 'open',
          firstTriggeredAt: now,
          lastEvaluatedAt: now,
          metadataJson: { balanceWei: '100' },
        }),
      ).resolves.toBeDefined();
    });
  });
});
