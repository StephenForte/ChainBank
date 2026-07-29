import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type {
  AuditEventRepository,
  ManagedWallet,
  ManagedWalletPatch,
  ManagedWalletRepository,
} from '../ports.js';

export interface UpdateWalletDependencies {
  readonly managedWallets: ManagedWalletRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface UpdateWalletInput {
  readonly role: Role;
  readonly walletId: string;
  readonly patch: ManagedWalletPatch;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Updates enablement and operational flags for a managed wallet.
 *
 * At least one patch field must be present. Authorization is enforced here.
 */
export async function updateWallet(
  dependencies: UpdateWalletDependencies,
  input: UpdateWalletInput,
): Promise<ManagedWallet> {
  assertPermission(input.role, 'wallet:write');

  if (
    input.patch.enabled === undefined &&
    input.patch.criticalAtStartup === undefined &&
    input.patch.reconciliationEnabled === undefined
  ) {
    throw new ChainBankError('INVALID_REQUEST', 'Wallet patch must include at least one field', {
      publicMessage: 'At least one field to update is required.',
    });
  }

  const existing = await dependencies.managedWallets.findById(input.walletId);
  if (existing === undefined) {
    throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${input.walletId} does not exist`);
  }

  const wallet = await dependencies.managedWallets.update(input.walletId, input.patch);

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: 'wallet.updated',
    entityType: 'managed_wallet',
    entityId: wallet.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: {
      previous: {
        enabled: existing.enabled,
        criticalAtStartup: existing.criticalAtStartup,
        reconciliationEnabled: existing.reconciliationEnabled,
      },
      next: {
        enabled: wallet.enabled,
        criticalAtStartup: wallet.criticalAtStartup,
        reconciliationEnabled: wallet.reconciliationEnabled,
      },
    },
  });

  return wallet;
}
