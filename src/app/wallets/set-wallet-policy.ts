import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { validatePolicy } from '../../domain/funding/index.js';
import type { ManagedWallet, OperatorMutationTransaction } from '../ports.js';

export interface SetWalletPolicyDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface SetWalletPolicyInput {
  readonly role: Role;
  readonly walletId: string;
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Creates or updates the funding policy for a managed wallet.
 *
 * Amount invariants are delegated to the domain validator. Each successful
 * write increments the policy version column. The policy write and its audit
 * entry commit atomically (C21).
 */
export async function setWalletPolicy(
  dependencies: SetWalletPolicyDependencies,
  input: SetWalletPolicyInput,
): Promise<ManagedWallet> {
  assertPermission(input.role, 'wallet:write');

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.managedWallets.findById(input.walletId);
    if (existing === undefined) {
      throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${input.walletId} does not exist`);
    }

    // Application enablement is a separate gate from amount validation; the
    // domain validator still receives isEnabled so the shared shape stays intact.
    const validation = validatePolicy({
      minimumBalanceWei: input.minimumBalanceWei,
      targetBalanceWei: input.targetBalanceWei,
      maximumTopUpWei: input.maximumTopUpWei,
      isEnabled: existing.enabled,
    });
    if (!validation.ok) {
      throw new ChainBankError(validation.code, validation.message, {
        publicMessage: validation.publicMessage,
      });
    }

    const previousVersion = existing.policy?.version;
    const policy = await uow.fundingPolicies.upsert({
      managedWalletId: existing.id,
      minimumBalanceWei: validation.policy.minimumBalanceWei,
      targetBalanceWei: validation.policy.targetBalanceWei,
      maximumTopUpWei: validation.policy.maximumTopUpWei,
    });

    const wallet = await uow.managedWallets.findById(existing.id);
    if (wallet === undefined) {
      throw new ChainBankError(
        'WALLET_NOT_FOUND',
        `Managed wallet ${existing.id} disappeared after policy write`,
      );
    }

    await uow.auditEvents.record({
      actorType: 'api_credential',
      actorId: input.actorId,
      action: 'wallet.policy.set',
      entityType: 'managed_wallet',
      entityId: wallet.id,
      requestId: input.operationId,
      sourceIp: input.sourceIp,
      metadata: {
        previousVersion: previousVersion ?? null,
        version: policy.version,
        minimumBalanceWei: policy.minimumBalanceWei.toString(),
        targetBalanceWei: policy.targetBalanceWei.toString(),
        maximumTopUpWei: policy.maximumTopUpWei.toString(),
      },
    });

    return wallet;
  });
}
