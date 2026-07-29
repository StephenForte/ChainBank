import type { Treasury } from '../../app/ports.js';
import { calculateSpendableWei, type TreasuryStatus } from '../../domain/treasury/treasury-status.js';
import { formatWeiAsEther } from '../../domain/wei.js';

/**
 * Wire representation of a treasury.
 *
 * Every quantity crosses the boundary as a decimal string: wei exceeds the
 * range JSON numbers can represent exactly, and an ether float would be wrong
 * in a way that is easy to miss.
 */
export interface TreasuryResource {
  readonly id: string;
  readonly status: TreasuryStatus;
  readonly enabled: boolean;
  readonly address: string;
  readonly explorerUrl: string;
  readonly chain: {
    readonly slug: string;
    readonly chainId: number;
    readonly displayName: string;
    readonly nativeSymbol: string;
  };
  readonly balance: {
    readonly wei: string | null;
    readonly ether: string | null;
    readonly observedAt: string | null;
  };
  readonly spendable: {
    readonly wei: string | null;
    readonly ether: string | null;
  };
  readonly thresholds: {
    readonly warningWei: string;
    readonly criticalWei: string;
    readonly recoveryWei: string;
    readonly minimumReserveWei: string;
    readonly warningEther: string;
    readonly criticalEther: string;
    readonly recoveryEther: string;
    readonly minimumReserveEther: string;
  };
  readonly lastCheckedAt: string | null;
  readonly lastCheckErrorCode: string | null;
}

export function serializeTreasury(treasury: Treasury): TreasuryResource {
  const balanceWei = treasury.lastObservedBalanceWei;
  const spendableWei =
    balanceWei === undefined ? undefined : calculateSpendableWei(balanceWei, treasury.thresholds);

  return {
    id: treasury.id,
    status: treasury.status,
    enabled: treasury.enabled,
    address: treasury.addressDisplay,
    explorerUrl: `${treasury.chain.explorerBaseUrl}/address/${treasury.addressDisplay}`,
    chain: {
      slug: treasury.chain.slug,
      chainId: treasury.chain.chainId,
      displayName: treasury.chain.displayName,
      nativeSymbol: treasury.chain.nativeSymbol,
    },
    balance: {
      wei: balanceWei === undefined ? null : balanceWei.toString(),
      ether: balanceWei === undefined ? null : formatWeiAsEther(balanceWei),
      observedAt: treasury.lastObservedAt?.toISOString() ?? null,
    },
    spendable: {
      wei: spendableWei === undefined ? null : spendableWei.toString(),
      ether: spendableWei === undefined ? null : formatWeiAsEther(spendableWei),
    },
    thresholds: {
      warningWei: treasury.thresholds.warningBalanceWei.toString(),
      criticalWei: treasury.thresholds.criticalBalanceWei.toString(),
      recoveryWei: treasury.thresholds.recoveryBalanceWei.toString(),
      minimumReserveWei: treasury.thresholds.minimumReserveWei.toString(),
      warningEther: formatWeiAsEther(treasury.thresholds.warningBalanceWei),
      criticalEther: formatWeiAsEther(treasury.thresholds.criticalBalanceWei),
      recoveryEther: formatWeiAsEther(treasury.thresholds.recoveryBalanceWei),
      minimumReserveEther: formatWeiAsEther(treasury.thresholds.minimumReserveWei),
    },
    lastCheckedAt: treasury.lastCheckedAt?.toISOString() ?? null,
    lastCheckErrorCode: treasury.lastCheckErrorCode ?? null,
  };
}
