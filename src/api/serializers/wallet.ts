import type { ManagedWallet, StoredFundingPolicy } from '../../app/ports.js';

export interface FundingPolicyResource {
  readonly minimumBalanceWei: string;
  readonly targetBalanceWei: string;
  readonly maximumTopUpWei: string;
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * Wire representation of a managed wallet.
 *
 * Wei quantities cross the boundary as decimal strings. Private-key fields are
 * never part of this contract.
 */
export interface ManagedWalletResource {
  readonly id: string;
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly enabled: boolean;
  };
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly role: string;
  readonly address: string;
  readonly explorerUrl: string;
  readonly enabled: boolean;
  readonly criticalAtStartup: boolean;
  readonly reconciliationEnabled: boolean;
  readonly policy: FundingPolicyResource | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeManagedWallet(wallet: ManagedWallet): ManagedWalletResource {
  return {
    id: wallet.id,
    project: {
      id: wallet.project.id,
      slug: wallet.project.slug,
      name: wallet.project.name,
      enabled: wallet.project.enabled,
    },
    environment: {
      id: wallet.environment.id,
      slug: wallet.environment.slug,
      name: wallet.environment.name,
      enabled: wallet.environment.enabled,
    },
    chain: {
      slug: wallet.chain.slug,
      chainId: wallet.chain.chainId,
      displayName: wallet.chain.displayName,
      nativeSymbol: wallet.chain.nativeSymbol,
    },
    role: wallet.role,
    address: wallet.addressDisplay,
    explorerUrl: `${wallet.chain.explorerBaseUrl}/address/${wallet.addressDisplay}`,
    enabled: wallet.enabled,
    criticalAtStartup: wallet.criticalAtStartup,
    reconciliationEnabled: wallet.reconciliationEnabled,
    policy: wallet.policy === undefined ? null : serializeFundingPolicy(wallet.policy),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function serializeFundingPolicy(policy: StoredFundingPolicy): FundingPolicyResource {
  return {
    minimumBalanceWei: policy.minimumBalanceWei.toString(),
    targetBalanceWei: policy.targetBalanceWei.toString(),
    maximumTopUpWei: policy.maximumTopUpWei.toString(),
    version: policy.version,
    updatedAt: policy.updatedAt.toISOString(),
  };
}
