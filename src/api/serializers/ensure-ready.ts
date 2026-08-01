import type { EnsureEnvironmentReadyResult } from '../../app/funding/ensure-environment-ready.js';

export interface EnsureReadyWalletResource {
  readonly walletId: string;
  readonly address: string;
  readonly criticalAtStartup: boolean;
  readonly status: string;
  readonly operationId: string | null;
  readonly reasonCode: string | null;
  readonly errorCode: string | null;
  readonly balanceBeforeWei: string | null;
  readonly minimumBalanceWei: string | null;
  readonly targetBalanceWei: string | null;
  readonly transferredWei: string | null;
  readonly transactionHash: string | null;
}

/**
 * Wire representation of environment ensure-ready (P2-US2 / C11).
 *
 * Wei quantities are decimal strings. Missing balances (per-wallet thrown
 * errors before a funding result exists) serialize as null.
 */
export interface EnsureReadyResource {
  readonly status: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly wallets: readonly EnsureReadyWalletResource[];
}

export function serializeEnsureReady(result: EnsureEnvironmentReadyResult): EnsureReadyResource {
  return {
    status: result.status,
    environmentId: result.environmentId,
    projectId: result.projectId,
    wallets: result.wallets.map((wallet) => ({
      walletId: wallet.walletId,
      address: wallet.address,
      criticalAtStartup: wallet.criticalAtStartup,
      status: wallet.status,
      operationId: wallet.operationId ?? null,
      reasonCode: wallet.reasonCode ?? null,
      errorCode: wallet.errorCode ?? null,
      balanceBeforeWei: weiOrNull(wallet.balanceBeforeWei),
      minimumBalanceWei: weiOrNull(wallet.minimumBalanceWei),
      targetBalanceWei: weiOrNull(wallet.targetBalanceWei),
      transferredWei: weiOrNull(wallet.transferredWei),
      transactionHash: wallet.transactionHash ?? null,
    })),
  };
}

function weiOrNull(value: bigint | undefined): string | null {
  return value === undefined ? null : value.toString();
}
