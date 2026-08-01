import type { Role } from '../../domain/auth/roles.js';
import { ChainBankError, isChainBankError } from '../../domain/errors.js';
import { assertNever } from '../../domain/funding/statuses.js';
import { authorizeScope } from '../auth/authorize-scope.js';
import type {
  EnvironmentRepository,
  ManagedWallet,
  ManagedWalletRepository,
  ProjectRepository,
} from '../ports.js';
import {
  ensureWalletFunded,
  type EnsureFundedStatus,
  type EnsureWalletFundedDependencies,
  type EnsureWalletFundedResult,
} from './ensure-wallet-funded.js';

/** Page size for wallet listing; must stay within the repository's safe bound. */
const WALLET_LIST_PAGE_SIZE = 100;

/**
 * Per-wallet readiness outcome for environment startup (PRD P2-US2 / C11).
 * `warning` and `blocked` are environment-level mappings of wallet
 * blocked/failed/error, gated by `criticalAtStartup`.
 */
export type EnsureReadyWalletStatus = 'no-op' | 'funded' | 'pending' | 'warning' | 'blocked';

/** Aggregate environment readiness. Precedence: blocked > degraded > pending > ready. */
export type EnsureReadyOverallStatus = 'ready' | 'degraded' | 'pending' | 'blocked';

export interface EnsureEnvironmentReadyDependencies extends EnsureWalletFundedDependencies {
  readonly environments: EnvironmentRepository;
  readonly projects: ProjectRepository;
  /** Injectable for unit tests; production uses {@link ensureWalletFunded}. */
  readonly fundWallet?: typeof ensureWalletFunded;
}

export interface EnsureEnvironmentReadyInput {
  readonly environmentId: string;
  readonly idempotencyKey: string;
  readonly role: Role;
  readonly credentialId: string;
  readonly correlationId: string;
  readonly sourceIp: string | undefined;
}

export interface EnsureReadyWalletResult {
  readonly walletId: string;
  readonly address: string;
  readonly criticalAtStartup: boolean;
  readonly status: EnsureReadyWalletStatus;
  readonly operationId: string | undefined;
  readonly reasonCode: string | undefined;
  readonly errorCode: string | undefined;
  readonly balanceBeforeWei: bigint | undefined;
  readonly minimumBalanceWei: bigint | undefined;
  readonly targetBalanceWei: bigint | undefined;
  readonly transferredWei: bigint | undefined;
  readonly transactionHash: string | undefined;
}

export interface EnsureEnvironmentReadyResult {
  readonly status: EnsureReadyOverallStatus;
  readonly environmentId: string;
  readonly projectId: string;
  readonly wallets: readonly EnsureReadyWalletResult[];
}

/**
 * Ensures every enabled managed wallet in an environment is ready for startup
 * (PRD P2-US2). Composes {@link ensureWalletFunded} once per wallet — does not
 * bypass destination allowlist, reserve, lock, or idempotency (C7 / C11).
 *
 * Security order:
 * 1. Resolve environment (404) and authorize `fund` at (project, environment).
 * 2. Refuse when project or environment is disabled (whole request).
 * 3. List all enabled wallets (paginated; never silently capped).
 * 4. Serial per-wallet ensure; catch per-wallet errors so one failure cannot
 *    hide the rest. `FUNDING_DISABLED` propagates (no read-only readiness path).
 */
export async function ensureEnvironmentReady(
  dependencies: EnsureEnvironmentReadyDependencies,
  input: EnsureEnvironmentReadyInput,
): Promise<EnsureEnvironmentReadyResult> {
  const environment = await dependencies.environments.findById(input.environmentId);
  if (environment === undefined) {
    throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} does not exist`, {
      publicMessage: 'The environment was not found.',
    });
  }

  await authorizeScope(
    { credentialScopes: dependencies.credentialScopes },
    {
      role: input.role,
      credentialId: input.credentialId,
      action: 'fund',
      projectId: environment.projectId,
      environmentId: environment.id,
    },
  );

  const project = await dependencies.projects.findById(environment.projectId);
  if (project === undefined) {
    throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${environment.projectId} does not exist`, {
      publicMessage: 'The project for this environment was not found.',
      context: { environmentId: environment.id, projectId: environment.projectId },
    });
  }

  // Fail closed for the whole sweep — never return ready for a disabled entity.
  if (!project.enabled) {
    throw new ChainBankError('ENTITY_DISABLED', `Project ${project.id} is disabled; refusing ensure-ready.`, {
      publicMessage: 'The project is disabled.',
      context: { projectId: project.id, environmentId: environment.id },
    });
  }
  if (!environment.enabled) {
    throw new ChainBankError(
      'ENTITY_DISABLED',
      `Environment ${environment.id} is disabled; refusing ensure-ready.`,
      {
        publicMessage: 'The environment is disabled.',
        context: { projectId: project.id, environmentId: environment.id },
      },
    );
  }

  const wallets = await listAllEnabledWallets(dependencies.managedWallets, environment.id);
  const fundWallet = dependencies.fundWallet ?? ensureWalletFunded;

  const walletResults: EnsureReadyWalletResult[] = [];
  for (const wallet of wallets) {
    try {
      const funded = await fundWallet(dependencies, {
        walletId: wallet.id,
        idempotencyKey: input.idempotencyKey,
        role: input.role,
        credentialId: input.credentialId,
        correlationId: input.correlationId,
        sourceIp: input.sourceIp,
      });
      walletResults.push(mapFundedResult(wallet, funded));
    } catch (error) {
      // Process-wide funding gate must abort the sweep, not become a per-wallet
      // warning that could look like a partial readiness report.
      if (isChainBankError(error) && error.code === 'FUNDING_DISABLED') {
        throw error;
      }
      walletResults.push(mapWalletError(wallet, error));
    }
  }

  return {
    status: aggregateOverallStatus(walletResults),
    environmentId: environment.id,
    projectId: project.id,
    wallets: walletResults,
  };
}

async function listAllEnabledWallets(
  managedWallets: ManagedWalletRepository,
  environmentId: string,
): Promise<readonly ManagedWallet[]> {
  const items: ManagedWallet[] = [];
  let offset = 0;
  for (;;) {
    const page = await managedWallets.list(
      { projectId: undefined, environmentId, enabled: true },
      { limit: WALLET_LIST_PAGE_SIZE, offset },
    );
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) {
      break;
    }
  }
  return items;
}

function mapFundedResult(wallet: ManagedWallet, result: EnsureWalletFundedResult): EnsureReadyWalletResult {
  return {
    walletId: wallet.id,
    address: wallet.addressDisplay,
    criticalAtStartup: wallet.criticalAtStartup,
    status: mapWalletStatus(result.status, wallet.criticalAtStartup),
    operationId: result.operationId,
    reasonCode: result.reasonCode,
    errorCode: undefined,
    balanceBeforeWei: result.balanceBeforeWei,
    minimumBalanceWei: result.minimumBalanceWei,
    targetBalanceWei: result.targetBalanceWei,
    transferredWei: result.transferredWei,
    transactionHash: result.transactionHash,
  };
}

function mapWalletError(wallet: ManagedWallet, error: unknown): EnsureReadyWalletResult {
  const errorCode = isChainBankError(error) ? error.code : 'INTERNAL_ERROR';
  return {
    walletId: wallet.id,
    address: wallet.addressDisplay,
    criticalAtStartup: wallet.criticalAtStartup,
    status: wallet.criticalAtStartup ? 'blocked' : 'warning',
    operationId: undefined,
    reasonCode: undefined,
    errorCode,
    balanceBeforeWei: undefined,
    minimumBalanceWei: wallet.policy?.minimumBalanceWei,
    targetBalanceWei: wallet.policy?.targetBalanceWei,
    transferredWei: undefined,
    transactionHash: undefined,
  };
}

function mapWalletStatus(status: EnsureFundedStatus, criticalAtStartup: boolean): EnsureReadyWalletStatus {
  switch (status) {
    case 'no-op':
      return 'no-op';
    case 'funded':
      return 'funded';
    case 'pending':
      return 'pending';
    case 'blocked':
    case 'failed':
      return criticalAtStartup ? 'blocked' : 'warning';
    default:
      return assertNever(status, 'EnsureFundedStatus');
  }
}

/**
 * Overall precedence (C11): any blocked → blocked; else any warning → degraded;
 * else any pending → pending; else ready (including zero wallets).
 */
export function aggregateOverallStatus(
  wallets: readonly Pick<EnsureReadyWalletResult, 'status'>[],
): EnsureReadyOverallStatus {
  let hasWarning = false;
  let hasPending = false;
  for (const wallet of wallets) {
    if (wallet.status === 'blocked') {
      return 'blocked';
    }
    if (wallet.status === 'warning') {
      hasWarning = true;
    } else if (wallet.status === 'pending') {
      hasPending = true;
    }
  }
  if (hasWarning) {
    return 'degraded';
  }
  if (hasPending) {
    return 'pending';
  }
  return 'ready';
}
