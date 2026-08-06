import { describe, expect, it, vi } from 'vitest';
import type {
  AuditEventRepository,
  ChainRepository,
  Environment,
  EnvironmentRepository,
  FundingPolicyRepository,
  FundingPolicyUpsertInput,
  ManagedWallet,
  ManagedWalletInsert,
  ManagedWalletPatch,
  ManagedWalletRepository,
  Project,
  ProjectRepository,
  StoredFundingPolicy,
} from '../../../src/app/ports.js';
import { listWallets } from '../../../src/app/wallets/list-wallets.js';
import { normalizeManagedAddress } from '../../../src/app/wallets/normalize-managed-address.js';
import { registerWallet } from '../../../src/app/wallets/register-wallet.js';
import { setWalletPolicy } from '../../../src/app/wallets/set-wallet-policy.js';
import { updateWallet } from '../../../src/app/wallets/update-wallet.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { createInlineOperatorMutations } from '../../support/operator-mutations.js';

const now = new Date('2026-07-28T12:00:00.000Z');

const project: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'fortel2',
  name: 'ForteL2',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const environment: Environment = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: project.id,
  slug: 'dev',
  name: 'Development',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const chain = {
  id: '33333333-3333-4333-8333-333333333333',
  slug: 'ethereum-sepolia',
  chainId: 11_155_111,
  displayName: 'Ethereum Sepolia',
  nativeSymbol: 'ETH',
  explorerBaseUrl: 'https://sepolia.etherscan.io',
};

const mixedCaseAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const lowercaseAddress = mixedCaseAddress.toLowerCase();

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    project,
    environment,
    chain,
    role: 'signer',
    address: lowercaseAddress,
    addressDisplay: mixedCaseAddress,
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: false,
    policy: undefined,
    createdAt: new Date('2026-07-28T12:00:00.000Z'),
    updatedAt: new Date('2026-07-28T12:00:00.000Z'),
    ...overrides,
  };
}

function buildPolicy(overrides: Partial<StoredFundingPolicy> = {}): StoredFundingPolicy {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    managedWalletId: '44444444-4444-4444-8444-444444444444',
    minimumBalanceWei: 100n,
    targetBalanceWei: 200n,
    maximumTopUpWei: 500n,
    version: 1,
    createdAt: new Date('2026-07-28T12:00:00.000Z'),
    updatedAt: new Date('2026-07-28T12:00:00.000Z'),
    ...overrides,
  };
}

function createDeps(options?: { readonly insertError?: Error; readonly existingWallet?: ManagedWallet }): {
  managedWallets: ManagedWalletRepository;
  projects: ProjectRepository;
  environments: EnvironmentRepository;
  chains: ChainRepository;
  fundingPolicies: FundingPolicyRepository;
  auditEvents: AuditEventRepository;
  operatorMutations: ReturnType<typeof createInlineOperatorMutations>;
} {
  const wallet = options?.existingWallet ?? buildWallet();
  const auditEvents: AuditEventRepository = {
    record: vi.fn(() => Promise.resolve(undefined)),
  };

  const managedWallets: ManagedWalletRepository = {
    insert: vi.fn((input: ManagedWalletInsert) => {
      if (options?.insertError !== undefined) {
        return Promise.reject(options.insertError);
      }
      return Promise.resolve(
        buildWallet({
          address: input.address,
          addressDisplay: normalizeManagedAddress(input.address).addressDisplay,
          role: input.role,
          criticalAtStartup: input.criticalAtStartup,
          reconciliationEnabled: input.reconciliationEnabled,
        }),
      );
    }),
    findById: vi.fn((id: string) => Promise.resolve(id === wallet.id ? wallet : undefined)),
    list: vi.fn(() => Promise.resolve({ items: [wallet], total: 1 })),
    update: vi.fn((_id: string, patch: ManagedWalletPatch) =>
      Promise.resolve(
        buildWallet({
          ...wallet,
          enabled: patch.enabled ?? wallet.enabled,
          criticalAtStartup: patch.criticalAtStartup ?? wallet.criticalAtStartup,
          reconciliationEnabled: patch.reconciliationEnabled ?? wallet.reconciliationEnabled,
        }),
      ),
    ),
  };
  const projects: ProjectRepository = {
    insert: vi.fn(),
    findById: vi.fn((id: string) => Promise.resolve(id === project.id ? project : undefined)),
    findBySlug: vi.fn(),
    list: vi.fn(),
    listByIds: vi.fn(),
    setEnabled: vi.fn(),
  };
  const environments: EnvironmentRepository = {
    insert: vi.fn(),
    findById: vi.fn((id: string) => Promise.resolve(id === environment.id ? environment : undefined)),
    listByProject: vi.fn(),
    setEnabled: vi.fn(),
  };
  const chains: ChainRepository = {
    upsert: vi.fn(),
    findByNumericChainId: vi.fn((chainId: number) =>
      Promise.resolve(chainId === chain.chainId ? chain : undefined),
    ),
  };
  const fundingPolicies: FundingPolicyRepository = {
    upsert: vi.fn((input: FundingPolicyUpsertInput) =>
      Promise.resolve(
        buildPolicy({
          managedWalletId: input.managedWalletId,
          minimumBalanceWei: input.minimumBalanceWei,
          targetBalanceWei: input.targetBalanceWei,
          maximumTopUpWei: input.maximumTopUpWei,
          version: (wallet.policy?.version ?? 0) + 1,
        }),
      ),
    ),
    findByManagedWalletId: vi.fn(() => Promise.resolve(wallet.policy)),
  };

  return {
    managedWallets,
    projects,
    environments,
    chains,
    fundingPolicies,
    auditEvents,
    operatorMutations: createInlineOperatorMutations({
      managedWallets,
      projects,
      environments,
      chains,
      fundingPolicies,
      auditEvents,
    }),
  };
}

describe('normalizeManagedAddress', () => {
  it('checksum-normalizes a valid address and lowercases the storage form', () => {
    const normalized = normalizeManagedAddress(mixedCaseAddress.toLowerCase());
    expect(normalized.address).toBe(lowercaseAddress);
    expect(normalized.addressDisplay).toBe(mixedCaseAddress);
  });

  it('rejects an invalid address', () => {
    expect(() => normalizeManagedAddress('not-an-address')).toThrow(ChainBankError);
    try {
      normalizeManagedAddress('0x1234');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INVALID_ADDRESS');
    }
  });
});

describe('registerWallet', () => {
  it('registers a wallet, normalizes the address, and emits an audit event', async () => {
    const dependencies = createDeps();
    const wallet = await registerWallet(
      { operatorMutations: dependencies.operatorMutations },
      {
        role: 'operator',
        projectId: project.id,
        environmentId: environment.id,
        chainId: chain.chainId,
        walletRole: 'signer',
        address: mixedCaseAddress,
        criticalAtStartup: true,
        reconciliationEnabled: false,
        operationId: 'op-1',
        actorId: 'cred-1',
        sourceIp: '127.0.0.1',
      },
    );

    expect(dependencies.managedWallets.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        address: lowercaseAddress,
        criticalAtStartup: true,
        reconciliationEnabled: false,
      }),
    );
    expect(wallet.address).toBe(lowercaseAddress);
    expect(wallet.addressDisplay).toBe(mixedCaseAddress);
    expect(dependencies.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.registered',
        entityType: 'managed_wallet',
        actorId: 'cred-1',
      }),
    );
  });

  it('denies registration for non-operator roles', async () => {
    const dependencies = createDeps();
    await expect(
      registerWallet(
        { operatorMutations: dependencies.operatorMutations },
        {
          role: 'read-only',
          projectId: project.id,
          environmentId: environment.id,
          chainId: chain.chainId,
          walletRole: 'signer',
          address: mixedCaseAddress,
          criticalAtStartup: false,
          reconciliationEnabled: false,
          operationId: 'op-deny',
          actorId: 'cred-ro',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(dependencies.managedWallets.insert).not.toHaveBeenCalled();
    expect(dependencies.auditEvents.record).not.toHaveBeenCalled();
  });

  it('surfaces duplicate registration conflicts from the repository', async () => {
    const dependencies = createDeps({
      insertError: new ChainBankError('WALLET_ALREADY_REGISTERED', 'duplicate', {
        publicMessage: 'already registered',
      }),
    });

    await expect(
      registerWallet(
        { operatorMutations: dependencies.operatorMutations },
        {
          role: 'operator',
          projectId: project.id,
          environmentId: environment.id,
          chainId: chain.chainId,
          walletRole: 'signer',
          address: mixedCaseAddress,
          criticalAtStartup: false,
          reconciliationEnabled: false,
          operationId: 'op-dup',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_REGISTERED' });
  });

  it('rejects an environment that does not belong to the project', async () => {
    const dependencies = createDeps();
    vi.mocked(dependencies.environments.findById).mockResolvedValue({
      ...environment,
      projectId: '99999999-9999-4999-8999-999999999999',
    });

    await expect(
      registerWallet(
        { operatorMutations: dependencies.operatorMutations },
        {
          role: 'operator',
          projectId: project.id,
          environmentId: environment.id,
          chainId: chain.chainId,
          walletRole: 'signer',
          address: mixedCaseAddress,
          criticalAtStartup: false,
          reconciliationEnabled: false,
          operationId: 'op-mismatch',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('listWallets', () => {
  it('allows operator and read-only roles', async () => {
    const dependencies = createDeps();
    await expect(
      listWallets(
        { managedWallets: dependencies.managedWallets },
        {
          role: 'read-only',
          filter: { projectId: undefined, environmentId: undefined, enabled: undefined },
          limit: 50,
          offset: 0,
        },
      ),
    ).resolves.toMatchObject({ total: 1 });
  });

  it('denies list for roles without wallet:read', async () => {
    const dependencies = createDeps();
    await expect(
      listWallets(
        { managedWallets: dependencies.managedWallets },
        {
          role: 'project-service',
          filter: { projectId: undefined, environmentId: undefined, enabled: undefined },
          limit: 50,
          offset: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('updateWallet', () => {
  it('updates enablement and emits an audit event', async () => {
    const existing = buildWallet({ enabled: true });
    const dependencies = createDeps({ existingWallet: existing });

    const updated = await updateWallet(
      {
        operatorMutations: dependencies.operatorMutations,
      },
      {
        role: 'operator',
        walletId: existing.id,
        patch: { enabled: false, criticalAtStartup: undefined, reconciliationEnabled: undefined },
        operationId: 'op-patch',
        actorId: 'cred-1',
        sourceIp: undefined,
      },
    );

    expect(updated.enabled).toBe(false);
    expect(dependencies.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.updated' }),
    );
  });

  it('denies updates for read-only roles', async () => {
    const dependencies = createDeps();
    await expect(
      updateWallet(
        {
          operatorMutations: dependencies.operatorMutations,
        },
        {
          role: 'read-only',
          walletId: buildWallet().id,
          patch: { enabled: false, criticalAtStartup: undefined, reconciliationEnabled: undefined },
          operationId: 'op-patch-deny',
          actorId: 'cred-ro',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('setWalletPolicy', () => {
  it('delegates validation, upserts policy, increments version, and audits', async () => {
    const existing = buildWallet({ policy: buildPolicy({ version: 2 }) });
    const dependencies = createDeps({ existingWallet: existing });
    const withPolicy = buildWallet({
      ...existing,
      policy: buildPolicy({ version: 3, minimumBalanceWei: 1_000n, targetBalanceWei: 2_000n }),
    });
    vi.mocked(dependencies.managedWallets.findById)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(withPolicy);

    const wallet = await setWalletPolicy(
      {
        operatorMutations: dependencies.operatorMutations,
      },
      {
        role: 'operator',
        walletId: existing.id,
        minimumBalanceWei: 1_000n,
        targetBalanceWei: 2_000n,
        maximumTopUpWei: 5_000n,
        operationId: 'op-policy',
        actorId: 'cred-1',
        sourceIp: undefined,
      },
    );

    expect(dependencies.fundingPolicies.upsert).toHaveBeenCalledWith({
      managedWalletId: existing.id,
      minimumBalanceWei: 1_000n,
      targetBalanceWei: 2_000n,
      maximumTopUpWei: 5_000n,
    });
    expect(wallet.policy?.version).toBe(3);
    const auditCall = vi.mocked(dependencies.auditEvents.record).mock.calls[0]?.[0];
    expect(auditCall).toMatchObject({
      action: 'wallet.policy.set',
      metadata: {
        previousVersion: 2,
        version: 3,
        minimumBalanceWei: '1000',
      },
    });
  });

  it('rejects invalid policy combinations via the domain validator', async () => {
    const existing = buildWallet();
    const dependencies = createDeps({ existingWallet: existing });

    await expect(
      setWalletPolicy(
        {
          operatorMutations: dependencies.operatorMutations,
        },
        {
          role: 'operator',
          walletId: existing.id,
          minimumBalanceWei: 2_000n,
          targetBalanceWei: 1_000n,
          maximumTopUpWei: 5_000n,
          operationId: 'op-bad-policy',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(dependencies.fundingPolicies.upsert).not.toHaveBeenCalled();
    expect(dependencies.auditEvents.record).not.toHaveBeenCalled();
  });

  it('denies policy writes for read-only roles', async () => {
    const dependencies = createDeps();
    await expect(
      setWalletPolicy(
        {
          operatorMutations: dependencies.operatorMutations,
        },
        {
          role: 'read-only',
          walletId: buildWallet().id,
          minimumBalanceWei: 1n,
          targetBalanceWei: 2n,
          maximumTopUpWei: 3n,
          operationId: 'op-policy-deny',
          actorId: 'cred-ro',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});
