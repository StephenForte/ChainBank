import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChainBankError } from '../../src/domain/errors.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

describe.skipIf(!integrationEnabled)('managed wallet and funding policy repositories', () => {
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

  it('rejects a duplicate chain+address insert via the unique constraint race path', async () => {
    const wallets = createManagedWalletRepository(handle.db);

    await expect(
      wallets.insert({
        environmentId: seed.environmentId,
        chainRowId: seed.chainId,
        role: 'duplicate',
        address: '0x2222222222222222222222222222222222222222',
        criticalAtStartup: false,
        reconciliationEnabled: false,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('WALLET_ALREADY_REGISTERED');
      return true;
    });
  });

  it('inserts a new managed wallet and loads project/environment/chain context', async () => {
    const wallets = createManagedWalletRepository(handle.db);
    const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const created = await wallets.insert({
      environmentId: seed.environmentId,
      chainRowId: seed.chainId,
      role: 'relayer',
      address,
      criticalAtStartup: true,
      reconciliationEnabled: true,
    });

    expect(created.address).toBe(address);
    expect(created.role).toBe('relayer');
    expect(created.criticalAtStartup).toBe(true);
    expect(created.reconciliationEnabled).toBe(true);
    expect(created.project.id).toBe(seed.projectId);
    expect(created.environment.id).toBe(seed.environmentId);
    expect(created.chain.id).toBe(seed.chainId);
    expect(created.policy).toBeUndefined();
  });

  it('filters list results by project, environment, and enabled', async () => {
    const wallets = createManagedWalletRepository(handle.db);
    const created = await wallets.insert({
      environmentId: seed.environmentId,
      chainRowId: seed.chainId,
      role: 'ci',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      criticalAtStartup: false,
      reconciliationEnabled: false,
    });
    await wallets.update(created.id, {
      enabled: false,
      criticalAtStartup: undefined,
      reconciliationEnabled: undefined,
    });

    const byProject = await wallets.list(
      { projectId: seed.projectId, environmentId: undefined, enabled: undefined },
      { limit: 50, offset: 0 },
    );
    expect(byProject.total).toBeGreaterThanOrEqual(2);

    const disabled = await wallets.list(
      { projectId: seed.projectId, environmentId: seed.environmentId, enabled: false },
      { limit: 50, offset: 0 },
    );
    expect(disabled.items.every((wallet) => !wallet.enabled)).toBe(true);
    expect(disabled.items.some((wallet) => wallet.id === created.id)).toBe(true);
  });

  it('upserts a funding policy and increments version on update', async () => {
    const policies = createFundingPolicyRepository(handle.db);

    const first = await policies.upsert({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: 100n,
      targetBalanceWei: 200n,
      maximumTopUpWei: 500n,
    });
    expect(first.version).toBe(1);

    const second = await policies.upsert({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: 150n,
      targetBalanceWei: 250n,
      maximumTopUpWei: 600n,
    });
    expect(second.version).toBe(2);
    expect(second.minimumBalanceWei).toBe(150n);
    expect(second.targetBalanceWei).toBe(250n);
    expect(second.maximumTopUpWei).toBe(600n);

    const loaded = await policies.findByManagedWalletId(seed.managedWalletId);
    expect(loaded?.version).toBe(2);
    expect(loaded?.minimumBalanceWei).toBe(150n);
  });
});
