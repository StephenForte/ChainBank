import { ChainBankError } from '../errors.js';
import type { TreasuryKind } from './treasury-kind.js';

/**
 * Minimal treasury shape for C23 resolution. Application `Treasury` satisfies this.
 */
export interface ResolvableTreasury {
  readonly id: string;
  readonly address: string;
  readonly kind: TreasuryKind;
  readonly enabled: boolean;
  readonly chain: { readonly chainId: number };
}

export type TreasuryResolutionError = {
  readonly code: 'TREASURY_NOT_FOUND' | 'INVALID_CONFIGURATION';
  readonly message: string;
  readonly publicMessage: string;
  readonly context: Readonly<Record<string, unknown>>;
};

export type TreasuryResolution<T extends ResolvableTreasury> =
  | { readonly kind: 'ok'; readonly treasury: T }
  | { readonly kind: 'error'; readonly error: TreasuryResolutionError };

/**
 * Selects the treasury that may fund managed wallets on `evmChainId` (C23).
 *
 * Two-tier: the single enabled `operational` row.
 * Legacy hatch: when no operational row exists, the sole enabled row (today's
 * `TREASURY_ADDRESS`, stored as `external`).
 * More than one enabled row of the same kind is always a hard error.
 */
export function resolveFundingTreasury<T extends ResolvableTreasury>(
  treasuries: readonly T[],
  evmChainId: number,
): TreasuryResolution<T> {
  const onChain = enabledOnChain(treasuries, evmChainId);
  const grouped = groupByKind(onChain);
  const kindError = ambiguousKindError(grouped, evmChainId);
  if (kindError !== undefined) {
    return { kind: 'error', error: kindError };
  }

  const operational = grouped.operational[0];
  if (operational !== undefined) {
    return { kind: 'ok', treasury: operational };
  }

  if (onChain.length === 1) {
    const sole = onChain[0];
    if (sole !== undefined) {
      return { kind: 'ok', treasury: sole };
    }
  }

  if (onChain.length === 0) {
    return {
      kind: 'error',
      error: {
        code: 'TREASURY_NOT_FOUND',
        message: `No enabled treasury is registered for chain ${String(evmChainId)}`,
        publicMessage: 'No enabled treasury is available for this wallet chain.',
        context: { chainId: evmChainId },
      },
    };
  }

  return {
    kind: 'error',
    error: {
      code: 'INVALID_CONFIGURATION',
      message: `Ambiguous treasury configuration for chain ${String(evmChainId)}: ${String(onChain.length)} enabled rows and no operational treasury.`,
      publicMessage: 'Funding is unavailable because treasury configuration is ambiguous for this chain.',
      context: {
        chainId: evmChainId,
        treasuryIds: onChain.map((row) => row.id),
        treasuryAddresses: onChain.map((row) => row.address),
      },
    },
  };
}

/**
 * Selects the Public (external) treasury that may replenish the operational
 * treasury on `evmChainId` (C23 / C24).
 */
export function resolveReplenishSource<T extends ResolvableTreasury>(
  treasuries: readonly T[],
  evmChainId: number,
): TreasuryResolution<T> {
  const onChain = enabledOnChain(treasuries, evmChainId);
  const grouped = groupByKind(onChain);
  const kindError = ambiguousKindError(grouped, evmChainId);
  if (kindError !== undefined) {
    return { kind: 'error', error: kindError };
  }

  const external = grouped.external[0];
  if (external === undefined) {
    return {
      kind: 'error',
      error: {
        code: 'TREASURY_NOT_FOUND',
        message: `No enabled external treasury is registered for chain ${String(evmChainId)}`,
        publicMessage: 'No Public treasury is available to replenish the Private treasury.',
        context: { chainId: evmChainId },
      },
    };
  }

  return { kind: 'ok', treasury: external };
}

/**
 * Selects the Private (operational) treasury that replenish may credit.
 */
export function resolveOperationalTreasury<T extends ResolvableTreasury>(
  treasuries: readonly T[],
  evmChainId: number,
): TreasuryResolution<T> {
  const onChain = enabledOnChain(treasuries, evmChainId);
  const grouped = groupByKind(onChain);
  const kindError = ambiguousKindError(grouped, evmChainId);
  if (kindError !== undefined) {
    return { kind: 'error', error: kindError };
  }

  const operational = grouped.operational[0];
  if (operational === undefined) {
    return {
      kind: 'error',
      error: {
        code: 'TREASURY_NOT_FOUND',
        message: `No enabled operational treasury is registered for chain ${String(evmChainId)}`,
        publicMessage: 'No Private treasury is configured for this chain.',
        context: { chainId: evmChainId },
      },
    };
  }

  return { kind: 'ok', treasury: operational };
}

export function throwTreasuryResolution<T extends ResolvableTreasury>(resolution: TreasuryResolution<T>): T {
  if (resolution.kind === 'ok') {
    return resolution.treasury;
  }
  throw new ChainBankError(resolution.error.code, resolution.error.message, {
    publicMessage: resolution.error.publicMessage,
    context: resolution.error.context,
  });
}

function enabledOnChain<T extends ResolvableTreasury>(
  treasuries: readonly T[],
  evmChainId: number,
): readonly T[] {
  return treasuries.filter((row) => row.enabled && row.chain.chainId === evmChainId);
}

function groupByKind<T extends ResolvableTreasury>(
  treasuries: readonly T[],
): { readonly external: readonly T[]; readonly operational: readonly T[] } {
  return {
    external: treasuries.filter((row) => row.kind === 'external'),
    operational: treasuries.filter((row) => row.kind === 'operational'),
  };
}

function ambiguousKindError<T extends ResolvableTreasury>(
  grouped: { readonly external: readonly T[]; readonly operational: readonly T[] },
  evmChainId: number,
): TreasuryResolutionError | undefined {
  if (grouped.external.length > 1) {
    return kindAmbiguity('external', grouped.external, evmChainId);
  }
  if (grouped.operational.length > 1) {
    return kindAmbiguity('operational', grouped.operational, evmChainId);
  }
  return undefined;
}

function kindAmbiguity<T extends ResolvableTreasury>(
  kind: TreasuryKind,
  matches: readonly T[],
  evmChainId: number,
): TreasuryResolutionError {
  const ids = matches.map((row) => row.id).join(', ');
  const addresses = matches.map((row) => row.address).join(', ');
  return {
    code: 'INVALID_CONFIGURATION',
    message: `Ambiguous ${kind} treasury configuration for chain ${String(evmChainId)}: ${String(matches.length)} enabled rows (${ids}; addresses ${addresses}). Disable the retired row before funding.`,
    publicMessage: 'Funding is unavailable because treasury configuration is ambiguous for this chain.',
    context: {
      chainId: evmChainId,
      treasuryKind: kind,
      treasuryIds: matches.map((row) => row.id),
      treasuryAddresses: matches.map((row) => row.address),
    },
  };
}
