import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialScope,
  CredentialScopeRepository,
  Environment,
  EnvironmentRepository,
  FundingTransactionHistoryItem,
  FundingTransactionListPage,
  FundingTransactionRepository,
  ManagedWallet,
  ManagedWalletRepository,
} from '../../../../src/app/ports.js';
import { listFundingTransactions } from '../../../../src/app/funding/list-funding-transactions.js';
import { ChainBankError } from '../../../../src/domain/errors.js';

const now = new Date('2026-07-28T12:00:00.000Z');
const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENV_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const WALLET_ID = '44444444-4444-4444-8444-444444444444';

const projectWideScope: CredentialScope = {
  id: '1',
  credentialId: CREDENTIAL_ID,
  projectId: PROJECT_A,
  environmentId: undefined,
  createdAt: now,
};

const envScope: CredentialScope = {
  id: '2',
  credentialId: CREDENTIAL_ID,
  projectId: PROJECT_A,
  environmentId: ENV_A,
  createdAt: now,
};

function buildHistoryItem(
  overrides: Partial<FundingTransactionHistoryItem> = {},
): FundingTransactionHistoryItem {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    operationId: '88888888-8888-4888-8888-888888888888',
    amountWei: 1_000_000_000_000_000n,
    transactionHash: '0xabc',
    nonce: 1,
    status: 'confirmed',
    errorCode: undefined,
    createdAt: now,
    submittedAt: now,
    confirmedAt: now,
    operation: {
      id: '88888888-8888-4888-8888-888888888888',
      operationType: 'ensure_funded',
      status: 'succeeded',
      requestedBy: 'cred-operator',
      startedAt: now,
      completedAt: now,
    },
    wallet: {
      id: WALLET_ID,
      role: 'signer',
      address: '0x2222222222222222222222222222222222222222',
      addressDisplay: '0x2222222222222222222222222222222222222222',
    },
    project: {
      id: PROJECT_A,
      slug: 'fortel2',
      name: 'ForteL2',
      enabled: true,
    },
    environment: {
      id: ENV_A,
      projectId: PROJECT_A,
      slug: 'dev',
      name: 'Development',
      enabled: true,
    },
    chain: {
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    ...overrides,
  };
}

function buildDeps(input: {
  readonly scopes?: readonly CredentialScope[];
  readonly listResult?: FundingTransactionListPage;
  readonly environment?: Environment;
  readonly wallet?: ManagedWallet;
}): {
  deps: {
    fundingTransactions: FundingTransactionRepository;
    credentialScopes: CredentialScopeRepository;
    environments: EnvironmentRepository;
    managedWallets: ManagedWalletRepository;
  };
  listMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(() =>
    Promise.resolve(input.listResult ?? { items: [buildHistoryItem()], total: 1 }),
  );

  return {
    listMock,
    deps: {
      fundingTransactions: { list: listMock } as unknown as FundingTransactionRepository,
      credentialScopes: {
        listByCredentialId: vi.fn(() => Promise.resolve(input.scopes ?? [])),
        insert: vi.fn(),
      },
      environments: {
        findById: vi.fn(() => Promise.resolve(input.environment)),
        insert: vi.fn(),
        listByProject: vi.fn(),
        setEnabled: vi.fn(),
      },
      managedWallets: {
        findById: vi.fn(() => Promise.resolve(input.wallet)),
      } as unknown as ManagedWalletRepository,
    },
  };
}

describe('listFundingTransactions', () => {
  it('denies cron roles by default', async () => {
    const { deps } = buildDeps({});

    await expect(
      listFundingTransactions(deps, {
        role: 'cron-treasury-monitor',
        credentialId: CREDENTIAL_ID,
        filter: {},
        limit: 50,
        offset: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INSUFFICIENT_ROLE');
      return true;
    });
  });

  it('returns an empty page when project-service has no scope rows', async () => {
    const { deps, listMock } = buildDeps({ scopes: [] });

    const result = await listFundingTransactions(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      filter: {},
      limit: 50,
      offset: 0,
    });

    expect(result).toEqual({ items: [], total: 0 });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('passes unrestricted scope for operator reads', async () => {
    const { deps, listMock } = buildDeps({});

    await listFundingTransactions(deps, {
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      filter: {},
      limit: 25,
      offset: 10,
    });

    expect(listMock).toHaveBeenCalledWith({ scope: { kind: 'unrestricted' } }, { limit: 25, offset: 10 });
  });

  it('passes scoped clauses for project-service credentials', async () => {
    const { deps, listMock } = buildDeps({ scopes: [projectWideScope, envScope] });

    await listFundingTransactions(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      filter: {},
      limit: 50,
      offset: 0,
    });

    expect(listMock).toHaveBeenCalledWith(
      {
        scope: {
          kind: 'scoped',
          clauses: [{ projectId: PROJECT_A }, { projectId: PROJECT_A, environmentId: ENV_A }],
        },
      },
      { limit: 50, offset: 0 },
    );
  });

  it('forwards filter combinations to the repository', async () => {
    const { deps, listMock } = buildDeps({});
    const createdFrom = new Date('2026-01-01T00:00:00.000Z');
    const createdTo = new Date('2026-12-31T23:59:59.999Z');

    await listFundingTransactions(deps, {
      role: 'read-only',
      credentialId: CREDENTIAL_ID,
      filter: {
        projectId: PROJECT_A,
        environmentId: ENV_A,
        managedWalletId: WALLET_ID,
        status: 'failed',
        createdFrom,
        createdTo,
      },
      limit: 10,
      offset: 5,
    });

    expect(listMock).toHaveBeenCalledWith(
      {
        projectId: PROJECT_A,
        environmentId: ENV_A,
        managedWalletId: WALLET_ID,
        status: 'failed',
        createdFrom,
        createdTo,
        scope: { kind: 'unrestricted' },
      },
      { limit: 10, offset: 5 },
    );
  });

  it('denies project-service access to an out-of-scope project filter', async () => {
    const { deps } = buildDeps({ scopes: [envScope] });

    await expect(
      listFundingTransactions(deps, {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        filter: { projectId: PROJECT_B },
        limit: 50,
        offset: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('SCOPE_DENIED');
      return true;
    });
  });

  it('applies pagination bounds through to the repository', async () => {
    const { deps, listMock } = buildDeps({
      listResult: { items: [], total: 42 },
    });

    const result = await listFundingTransactions(deps, {
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      filter: {},
      limit: 1,
      offset: 41,
    });

    expect(listMock).toHaveBeenCalledWith({ scope: { kind: 'unrestricted' } }, { limit: 1, offset: 41 });
    expect(result.total).toBe(42);
  });
});
