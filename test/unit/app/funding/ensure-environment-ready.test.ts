import { describe, expect, it, vi } from 'vitest';
import {
  aggregateOverallStatus,
  ensureEnvironmentReady,
  type EnsureEnvironmentReadyDependencies,
  type EnsureReadyWalletResult,
} from '../../../../src/app/funding/ensure-environment-ready.js';
import type { EnsureWalletFundedResult } from '../../../../src/app/funding/ensure-wallet-funded.js';
import type {
  CredentialScope,
  CredentialScopeRepository,
  Environment,
  EnvironmentRepository,
  ManagedWallet,
  ManagedWalletRepository,
  Project,
  ProjectRepository,
} from '../../../../src/app/ports.js';
import type { Role } from '../../../../src/domain/auth/roles.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import { createFakeReceiptTracker, createFakeSigner } from '../../../support/funding-fakes.js';

const ONE_ETH = 10n ** 18n;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENV_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const WALLET_A = '44444444-4444-4444-8444-444444444444';
const WALLET_B = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-08-01T12:00:00.000Z');

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    slug: 'fortel2',
    name: 'ForteL2',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: ENV_ID,
    projectId: PROJECT_ID,
    slug: 'dev',
    name: 'Development',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  const id = overrides.id ?? WALLET_A;
  return {
    id,
    project: { id: PROJECT_ID, slug: 'fortel2', name: 'ForteL2', enabled: true },
    environment: {
      id: ENV_ID,
      projectId: PROJECT_ID,
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
    policy: {
      id: `policy-${id}`,
      managedWalletId: id,
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fundedResult(
  status: EnsureWalletFundedResult['status'],
  overrides: Partial<EnsureWalletFundedResult> = {},
): EnsureWalletFundedResult {
  return {
    status,
    operationId: '66666666-6666-4666-8666-666666666666',
    balanceBeforeWei: ONE_ETH / 10n,
    minimumBalanceWei: ONE_ETH,
    targetBalanceWei: 2n * ONE_ETH,
    transferredWei: status === 'funded' ? 2n * ONE_ETH - ONE_ETH / 10n : undefined,
    transactionHash: status === 'funded' || status === 'pending' ? `0x${'ab'.repeat(32)}` : undefined,
    explorerBaseUrl: 'https://sepolia.etherscan.io',
    reasonCode: status === 'blocked' ? 'FUNDING_BLOCKED_RESERVE' : undefined,
    ...overrides,
  };
}

function createScopeRepo(scopes: readonly CredentialScope[] = []): CredentialScopeRepository {
  return {
    listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
    insert: vi.fn(),
  };
}

function buildDeps(options?: {
  readonly role?: Role;
  readonly scopes?: readonly CredentialScope[];
  readonly environment?: Environment | undefined;
  readonly project?: Project | undefined;
  readonly wallets?: readonly ManagedWallet[];
  readonly fundWallet?: EnsureEnvironmentReadyDependencies['fundWallet'];
}): {
  readonly dependencies: EnsureEnvironmentReadyDependencies;
  readonly input: Parameters<typeof ensureEnvironmentReady>[1];
  readonly fundWallet: ReturnType<typeof vi.fn>;
  readonly managedWallets: ManagedWalletRepository;
} {
  const environment = options && 'environment' in options ? options.environment : buildEnvironment();
  const project = options && 'project' in options ? options.project : buildProject();
  const wallets = options?.wallets ?? [buildWallet()];
  const fundWallet = options?.fundWallet ?? vi.fn(() => Promise.resolve(fundedResult('funded')));

  const environments: EnvironmentRepository = {
    findById: vi.fn(() => Promise.resolve(environment)),
    insert: vi.fn(),
    listByProject: vi.fn(),
    setEnabled: vi.fn(),
  };
  const projects: ProjectRepository = {
    findById: vi.fn(() => Promise.resolve(project)),
    insert: vi.fn(),
    findBySlug: vi.fn(),
    list: vi.fn(),
    listByIds: vi.fn(),
    setEnabled: vi.fn(),
  };
  const managedWallets: ManagedWalletRepository = {
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    list: vi.fn((_filter, pagination: { readonly limit: number; readonly offset: number }) => {
      const slice = wallets.slice(pagination.offset, pagination.offset + pagination.limit);
      return Promise.resolve({ items: slice, total: wallets.length });
    }),
  };

  const dependencies: EnsureEnvironmentReadyDependencies = {
    environments,
    projects,
    managedWallets,
    treasuries: {
      listEnabled: vi.fn(),
      findById: vi.fn(),
      upsert: vi.fn(),
      setEnabled: vi.fn(),
      recordCheckSuccess: vi.fn(),
      recordCheckFailure: vi.fn(),
      recordOutgoingScanComplete: vi.fn(),
    },
    balanceObservations: { record: vi.fn(), findLatest: vi.fn() },
    balanceReader: {
      readBalance: vi.fn(),
      verifyChainId: vi.fn(),
    },
    credentialScopes: createScopeRepo(options?.scopes ?? []),
    auditEvents: { record: vi.fn() },
    alerts: {
      findOpenByEntity: vi.fn(),
      insertOpen: vi.fn(),
      markEscalated: vi.fn(),
      markPendingEmail: vi.fn(),
      clearPendingEmail: vi.fn(),
      acknowledgeSend: vi.fn(),
      resolve: vi.fn(),
      touchLastEvaluated: vi.fn(),
    },
    emailSender: undefined,
    operations: {} as EnsureEnvironmentReadyDependencies['operations'],
    transactions: {} as EnsureEnvironmentReadyDependencies['transactions'],
    lock: { runExclusive: vi.fn() },
    receiptTracker: createFakeReceiptTracker({
      kind: 'confirmed',
      confirmedAt: now,
    }),
    signer: createFakeSigner({}),
    clock: createFixedClock(now),
    idGenerator: { next: () => 'id-1' },
    logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    isFundingEnabled: true,
    isFundingKillSwitchActive: false,
    confirmations: 1,
    confirmationTimeoutMs: 60_000,
    operatorRecipients: ['operator@example.com'],
    dashboardBaseUrl: 'http://localhost:3000',
    environment: 'test',
    fundWallet,
  };

  return {
    dependencies,
    input: {
      environmentId: ENV_ID,
      idempotencyKey: 'env-ready-1',
      role: options?.role ?? 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-1',
      sourceIp: '127.0.0.1',
    },
    fundWallet: fundWallet as ReturnType<typeof vi.fn>,
    managedWallets,
  };
}

describe('aggregateOverallStatus', () => {
  it('returns ready for an empty wallet list', () => {
    expect(aggregateOverallStatus([])).toBe('ready');
  });

  it('applies blocked > degraded > pending > ready precedence', () => {
    expect(aggregateOverallStatus([{ status: 'no-op' }, { status: 'funded' }])).toBe('ready');
    expect(aggregateOverallStatus([{ status: 'pending' }, { status: 'funded' }])).toBe('pending');
    expect(aggregateOverallStatus([{ status: 'warning' }, { status: 'pending' }])).toBe('degraded');
    expect(aggregateOverallStatus([{ status: 'blocked' }, { status: 'warning' }])).toBe('blocked');
  });
});

describe('ensureEnvironmentReady', () => {
  describe('mapping matrix', () => {
    const cases: {
      readonly fundedStatus: EnsureWalletFundedResult['status'];
      readonly critical: boolean;
      readonly expectedWallet: EnsureReadyWalletResult['status'];
      readonly expectedOverall: 'ready' | 'degraded' | 'pending' | 'blocked';
    }[] = [
      { fundedStatus: 'no-op', critical: true, expectedWallet: 'no-op', expectedOverall: 'ready' },
      { fundedStatus: 'no-op', critical: false, expectedWallet: 'no-op', expectedOverall: 'ready' },
      { fundedStatus: 'funded', critical: true, expectedWallet: 'funded', expectedOverall: 'ready' },
      { fundedStatus: 'funded', critical: false, expectedWallet: 'funded', expectedOverall: 'ready' },
      { fundedStatus: 'pending', critical: true, expectedWallet: 'pending', expectedOverall: 'pending' },
      { fundedStatus: 'pending', critical: false, expectedWallet: 'pending', expectedOverall: 'pending' },
      { fundedStatus: 'blocked', critical: true, expectedWallet: 'blocked', expectedOverall: 'blocked' },
      { fundedStatus: 'blocked', critical: false, expectedWallet: 'warning', expectedOverall: 'degraded' },
      { fundedStatus: 'failed', critical: true, expectedWallet: 'blocked', expectedOverall: 'blocked' },
      { fundedStatus: 'failed', critical: false, expectedWallet: 'warning', expectedOverall: 'degraded' },
    ];

    for (const testCase of cases) {
      it(`maps ${testCase.fundedStatus} + critical=${String(testCase.critical)} → wallet ${testCase.expectedWallet}, overall ${testCase.expectedOverall}`, async () => {
        const wallet = buildWallet({ criticalAtStartup: testCase.critical });
        const { dependencies, input } = buildDeps({
          wallets: [wallet],
          fundWallet: vi.fn(() => Promise.resolve(fundedResult(testCase.fundedStatus))),
        });

        const result = await ensureEnvironmentReady(dependencies, input);
        expect(result.wallets).toHaveLength(1);
        expect(result.wallets[0]?.status).toBe(testCase.expectedWallet);
        expect(result.status).toBe(testCase.expectedOverall);
      });
    }
  });

  it('returns ready for a zero-wallet environment without calling fundWallet', async () => {
    const { dependencies, input, fundWallet } = buildDeps({ wallets: [] });
    const result = await ensureEnvironmentReady(dependencies, input);
    expect(result.status).toBe('ready');
    expect(result.wallets).toEqual([]);
    expect(fundWallet).not.toHaveBeenCalled();
  });

  it('refuses when the project is disabled', async () => {
    const { dependencies, input, fundWallet } = buildDeps({
      project: buildProject({ enabled: false }),
    });
    await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
      code: 'ENTITY_DISABLED',
    });
    expect(fundWallet).not.toHaveBeenCalled();
  });

  it('refuses when the environment is disabled', async () => {
    const { dependencies, input, fundWallet } = buildDeps({
      environment: buildEnvironment({ enabled: false }),
    });
    await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
      code: 'ENTITY_DISABLED',
    });
    expect(fundWallet).not.toHaveBeenCalled();
  });

  it('returns ENVIRONMENT_NOT_FOUND for an unknown environment', async () => {
    const { dependencies, input, fundWallet } = buildDeps({ environment: undefined });
    await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND',
    });
    expect(fundWallet).not.toHaveBeenCalled();
  });

  it('contains per-wallet errors so later wallets still run', async () => {
    const critical = buildWallet({ id: WALLET_A, criticalAtStartup: true });
    const healthy = buildWallet({
      id: WALLET_B,
      address: '0x3333333333333333333333333333333333333333',
      addressDisplay: '0x3333333333333333333333333333333333333333',
      criticalAtStartup: false,
    });
    const fundWallet = vi.fn((_deps, fundInput: { readonly walletId: string }) => {
      if (fundInput.walletId === WALLET_A) {
        return Promise.reject(
          new ChainBankError('RPC_UNAVAILABLE', 'simulated rpc failure', {
            publicMessage: 'Chain unavailable.',
          }),
        );
      }
      return Promise.resolve(fundedResult('funded'));
    });

    const { dependencies, input } = buildDeps({ wallets: [critical, healthy], fundWallet });
    const result = await ensureEnvironmentReady(dependencies, input);

    expect(fundWallet).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('blocked');
    expect(result.wallets[0]).toMatchObject({
      walletId: WALLET_A,
      status: 'blocked',
      errorCode: 'RPC_UNAVAILABLE',
    });
    expect(result.wallets[1]).toMatchObject({
      walletId: WALLET_B,
      status: 'funded',
    });
  });

  it('maps a non-critical thrown error to warning / degraded', async () => {
    const wallet = buildWallet({ criticalAtStartup: false });
    const { dependencies, input } = buildDeps({
      wallets: [wallet],
      fundWallet: vi.fn(() =>
        Promise.reject(
          new ChainBankError('INVALID_REQUEST', 'no policy', {
            publicMessage: 'Policy required.',
          }),
        ),
      ),
    });

    const result = await ensureEnvironmentReady(dependencies, input);
    expect(result.status).toBe('degraded');
    expect(result.wallets[0]).toMatchObject({
      status: 'warning',
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('propagates FUNDING_DISABLED instead of mapping it per wallet', async () => {
    const { dependencies, input, fundWallet } = buildDeps({
      wallets: [buildWallet(), buildWallet({ id: WALLET_B })],
      fundWallet: vi.fn(() =>
        Promise.reject(
          new ChainBankError('FUNDING_DISABLED', 'funding off', { publicMessage: 'Funding is disabled.' }),
        ),
      ),
    });

    await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
      code: 'FUNDING_DISABLED',
    });
    // Aborts on the first wallet; does not continue the sweep.
    expect(fundWallet).toHaveBeenCalledTimes(1);
  });

  it('passes the caller idempotency key through to each wallet fund call', async () => {
    const wallets = [
      buildWallet({ id: WALLET_A }),
      buildWallet({
        id: WALLET_B,
        address: '0x3333333333333333333333333333333333333333',
        addressDisplay: '0x3333333333333333333333333333333333333333',
      }),
    ];
    const { dependencies, input, fundWallet } = buildDeps({ wallets });
    await ensureEnvironmentReady(dependencies, input);

    expect(fundWallet).toHaveBeenCalledTimes(2);
    expect(fundWallet.mock.calls[0]?.[1]).toMatchObject({
      walletId: WALLET_A,
      idempotencyKey: 'env-ready-1',
    });
    expect(fundWallet.mock.calls[1]?.[1]).toMatchObject({
      walletId: WALLET_B,
      idempotencyKey: 'env-ready-1',
    });
  });

  it('paginates through all enabled wallets', async () => {
    const wallets = Array.from({ length: 101 }, (_, index) =>
      buildWallet({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
        address: `0x${String(index).padStart(40, '0')}`,
        addressDisplay: `0x${String(index).padStart(40, '0')}`,
      }),
    );
    const { dependencies, input, fundWallet, managedWallets } = buildDeps({ wallets });
    await ensureEnvironmentReady(dependencies, input);

    expect(managedWallets.list).toHaveBeenCalled();
    expect(fundWallet).toHaveBeenCalledTimes(101);
  });

  describe('authorization matrix', () => {
    it('allows operator', async () => {
      const { dependencies, input } = buildDeps({ role: 'operator' });
      await expect(ensureEnvironmentReady(dependencies, input)).resolves.toMatchObject({
        status: 'ready',
      });
    });

    it('allows project-service when scoped to the environment', async () => {
      const { dependencies, input } = buildDeps({
        role: 'project-service',
        scopes: [
          {
            id: 'scope-1',
            credentialId: CREDENTIAL_ID,
            projectId: PROJECT_ID,
            environmentId: ENV_ID,
            createdAt: now,
          },
        ],
      });
      await expect(ensureEnvironmentReady(dependencies, input)).resolves.toMatchObject({
        status: 'ready',
      });
    });

    it('denies project-service when not scoped', async () => {
      const { dependencies, input, fundWallet } = buildDeps({
        role: 'project-service',
        scopes: [],
      });
      await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
        code: 'SCOPE_DENIED',
      });
      expect(fundWallet).not.toHaveBeenCalled();
    });

    it('denies read-only', async () => {
      const { dependencies, input, fundWallet } = buildDeps({ role: 'read-only' });
      await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
        code: 'INSUFFICIENT_ROLE',
      });
      expect(fundWallet).not.toHaveBeenCalled();
    });

    it('denies cron roles', async () => {
      for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
        const { dependencies, input, fundWallet } = buildDeps({ role });
        await expect(ensureEnvironmentReady(dependencies, input)).rejects.toMatchObject({
          code: 'INSUFFICIENT_ROLE',
        });
        expect(fundWallet).not.toHaveBeenCalled();
      }
    });
  });
});
