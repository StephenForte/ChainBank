import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type {
  AuditEventRepository,
  ChainRepository,
  EnvironmentRepository,
  ManagedWallet,
  ManagedWalletRepository,
  ProjectRepository,
} from '../ports.js';
import { normalizeManagedAddress } from './normalize-managed-address.js';

export interface RegisterWalletDependencies {
  readonly managedWallets: ManagedWalletRepository;
  readonly projects: ProjectRepository;
  readonly environments: EnvironmentRepository;
  readonly chains: ChainRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface RegisterWalletInput {
  readonly role: Role;
  readonly projectId: string;
  readonly environmentId: string;
  /** EVM numeric chain ID; resolved against the registered chains table. */
  readonly chainId: number;
  readonly walletRole: string;
  readonly address: string;
  readonly criticalAtStartup: boolean;
  readonly reconciliationEnabled: boolean;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Registers a managed recipient wallet under a project/environment.
 *
 * Never accepts private-key material. Duplicate (chain, address) rows are
 * rejected, including races handled by the database unique constraint.
 */
export async function registerWallet(
  dependencies: RegisterWalletDependencies,
  input: RegisterWalletInput,
): Promise<ManagedWallet> {
  assertPermission(input.role, 'wallet:write');

  const project = await dependencies.projects.findById(input.projectId);
  if (project === undefined) {
    throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${input.projectId} does not exist`);
  }

  const environment = await dependencies.environments.findById(input.environmentId);
  if (environment === undefined) {
    throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} does not exist`);
  }
  if (environment.projectId !== project.id) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Environment ${environment.id} does not belong to project ${project.id}`,
      {
        publicMessage: 'The environment does not belong to the specified project.',
        context: { projectId: project.id, environmentId: environment.id },
      },
    );
  }

  const chain = await dependencies.chains.findByNumericChainId(input.chainId);
  if (chain === undefined) {
    throw new ChainBankError('CHAIN_NOT_FOUND', `Chain ${String(input.chainId)} is not registered`);
  }

  const walletRole = input.walletRole.trim();
  if (walletRole.length === 0) {
    throw new ChainBankError('INVALID_REQUEST', 'Managed wallet role must not be empty', {
      publicMessage: 'A wallet role is required.',
    });
  }

  const normalized = normalizeManagedAddress(input.address);

  const wallet = await dependencies.managedWallets.insert({
    environmentId: environment.id,
    chainRowId: chain.id,
    role: walletRole,
    address: normalized.address,
    criticalAtStartup: input.criticalAtStartup,
    reconciliationEnabled: input.reconciliationEnabled,
  });

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: 'wallet.registered',
    entityType: 'managed_wallet',
    entityId: wallet.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: {
      projectId: project.id,
      environmentId: environment.id,
      chainId: chain.chainId,
      role: wallet.role,
      address: wallet.addressDisplay,
      criticalAtStartup: wallet.criticalAtStartup,
      reconciliationEnabled: wallet.reconciliationEnabled,
    },
  });

  return wallet;
}
