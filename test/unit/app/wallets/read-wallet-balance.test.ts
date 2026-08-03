import { describe, expect, it, vi } from 'vitest';
import type {
  BalanceReader,
  CredentialScope,
  CredentialScopeRepository,
  ManagedWallet,
  ManagedWalletRepository,
} from '../../../../src/app/ports.js';
import { readWalletBalance } from '../../../../src/app/wallets/read-wallet-balance.js';
import type { Role } from '../../../../src/domain/auth/roles.js';

const WALLET_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_WALLET_ID = '55555555-5555-4555-8555-555555555555';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ENV_A = '22222222-2222-4222-8222-222222222222';
const ENV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = new Date('2026-08-02T12:00:00.000Z');

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id: WALLET_ID,
    project: { id: PROJECT_A, slug: 'fortel2', name: 'ForteL2', enabled: true },
    environment: {
      id: ENV_A,
      projectId: PROJECT_A,
      slug: 'dev',
      name: 'Development',
      enabled: true,
    },
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    role: 'signer',
    address: '0x2222222222222222222222222222222222222222',
    addressDisplay: '0x2222222222222222222222222222222222222222',
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: false,
    policy: undefined,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function scopeRepo(scopes: readonly CredentialScope[]): CredentialScopeRepository {
  return {
    listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
    insert: vi.fn(),
  };
}

function observedReader(balanceWei = 10n ** 17n): BalanceReader {
  return {
    readBalance: vi.fn(() =>
      Promise.resolve({
        kind: 'observed' as const,
        balanceWei,
        blockNumber: 99n,
        observedAt: now,
      }),
    ),
    verifyChainId: vi.fn(() => Promise.resolve({ matches: true, observedChainId: 11_155_111 })),
  };
}

function unavailableReader(): BalanceReader {
  return {
    readBalance: vi.fn(() =>
      Promise.resolve({
        kind: 'unavailable' as const,
        errorCode: 'RPC_UNAVAILABLE' as const,
        reason: 'provider timeout',
        observedAt: now,
      }),
    ),
    verifyChainId: vi.fn(() => Promise.resolve({ matches: true, observedChainId: 11_155_111 })),
  };
}

function buildDeps(options: {
  readonly wallet?: ManagedWallet | undefined;
  readonly scopes?: readonly CredentialScope[];
  readonly balanceReader?: BalanceReader;
}) {
  const wallet = options.wallet;
  const managedWallets: ManagedWalletRepository = {
    insert: vi.fn(),
    findById: vi.fn((id: string) =>
      Promise.resolve(wallet !== undefined && wallet.id === id ? wallet : undefined),
    ),
    list: vi.fn(),
    update: vi.fn(),
  };

  return {
    managedWallets,
    credentialScopes: scopeRepo(options.scopes ?? []),
    balanceReader: options.balanceReader ?? observedReader(),
  };
}

describe('readWalletBalance', () => {
  it('returns an observed reading for operator', async () => {
    const wallet = buildWallet();
    const deps = buildDeps({ wallet });
    const result = await readWalletBalance(deps, {
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      walletId: WALLET_ID,
    });

    expect(result.wallet).toBe(wallet);
    expect(result.reading).toMatchObject({
      kind: 'observed',
      balanceWei: 10n ** 17n,
      blockNumber: 99n,
    });
    expect(deps.balanceReader.readBalance).toHaveBeenCalledWith(wallet.addressDisplay);
  });

  it('returns an observed reading for read-only', async () => {
    const deps = buildDeps({ wallet: buildWallet() });
    const result = await readWalletBalance(deps, {
      role: 'read-only',
      credentialId: CREDENTIAL_ID,
      walletId: WALLET_ID,
    });
    expect(result.reading.kind).toBe('observed');
  });

  it('allows in-scope project-service credentials', async () => {
    const deps = buildDeps({
      wallet: buildWallet(),
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: now,
        },
      ],
    });

    const result = await readWalletBalance(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      walletId: WALLET_ID,
    });
    expect(result.reading.kind).toBe('observed');
  });

  it('allows project-service with matching env-level scope', async () => {
    const deps = buildDeps({
      wallet: buildWallet(),
      scopes: [
        {
          id: 'scope-env',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: ENV_A,
          createdAt: now,
        },
      ],
    });

    const result = await readWalletBalance(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      walletId: WALLET_ID,
    });
    expect(result.reading.kind).toBe('observed');
  });

  it('denies out-of-scope project-service with SCOPE_DENIED after wallet exists', async () => {
    const deps = buildDeps({
      wallet: buildWallet({
        project: { id: PROJECT_B, slug: 'other', name: 'Other', enabled: true },
        environment: {
          id: ENV_B,
          projectId: PROJECT_B,
          slug: 'prod',
          name: 'Production',
          enabled: true,
        },
      }),
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: now,
        },
      ],
    });

    await expect(
      readWalletBalance(deps, {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        walletId: WALLET_ID,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    expect(deps.balanceReader.readBalance).not.toHaveBeenCalled();
  });

  it('denies project-service scoped to a different environment in the same project', async () => {
    const deps = buildDeps({
      wallet: buildWallet(),
      scopes: [
        {
          id: 'scope-other-env',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: ENV_B,
          createdAt: now,
        },
      ],
    });

    await expect(
      readWalletBalance(deps, {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        walletId: WALLET_ID,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(deps.balanceReader.readBalance).not.toHaveBeenCalled();
  });

  it('returns WALLET_NOT_FOUND for unknown wallet before scope check', async () => {
    const deps = buildDeps({
      wallet: undefined,
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: now,
        },
      ],
    });

    await expect(
      readWalletBalance(deps, {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        walletId: OTHER_WALLET_ID,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });

    expect(deps.credentialScopes.listByCredentialId).not.toHaveBeenCalled();
    expect(deps.balanceReader.readBalance).not.toHaveBeenCalled();
  });

  it('denies cron roles with INSUFFICIENT_ROLE without reading balance', async () => {
    const deps = buildDeps({ wallet: buildWallet() });
    for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
      await expect(
        readWalletBalance(deps, {
          role,
          credentialId: CREDENTIAL_ID,
          walletId: WALLET_ID,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    }
    expect(deps.managedWallets.findById).not.toHaveBeenCalled();
    expect(deps.balanceReader.readBalance).not.toHaveBeenCalled();
  });

  it('returns unavailable reading on provider failure without inventing zero', async () => {
    const deps = buildDeps({
      wallet: buildWallet(),
      balanceReader: unavailableReader(),
    });

    const result = await readWalletBalance(deps, {
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      walletId: WALLET_ID,
    });

    expect(result.reading).toEqual({
      kind: 'unavailable',
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'provider timeout',
      observedAt: now,
    });
    expect('balanceWei' in result.reading).toBe(false);
  });

  it('covers the role matrix for permission gate', async () => {
    const allowed: Role[] = ['operator', 'read-only', 'project-service'];
    const denied: Role[] = ['cron-treasury-monitor', 'cron-reconciler'];

    for (const role of allowed) {
      const deps = buildDeps({
        wallet: buildWallet(),
        scopes:
          role === 'project-service'
            ? [
                {
                  id: 'scope-1',
                  credentialId: CREDENTIAL_ID,
                  projectId: PROJECT_A,
                  environmentId: undefined,
                  createdAt: now,
                },
              ]
            : [],
      });
      await expect(
        readWalletBalance(deps, {
          role,
          credentialId: CREDENTIAL_ID,
          walletId: WALLET_ID,
        }),
      ).resolves.toMatchObject({ reading: { kind: 'observed' } });
    }

    for (const role of denied) {
      const deps = buildDeps({ wallet: buildWallet() });
      await expect(
        readWalletBalance(deps, {
          role,
          credentialId: CREDENTIAL_ID,
          walletId: WALLET_ID,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    }
  });
});
