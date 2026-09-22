import type { ChainBankConfig, ConfiguredChain } from '../../config/index.js';
import { ChainBankError } from '../../domain/errors.js';
import {
  assertValidTreasuryThresholds,
  type TreasuryThresholds,
} from '../../domain/treasury/treasury-status.js';
import type { TreasuryKind } from '../../domain/treasury/treasury-kind.js';
import type {
  ChainRegistration,
  ChainRepository,
  Treasury,
  TreasuryFundingPolicyAmounts,
  TreasuryRepository,
} from '../ports.js';

export interface RegisterConfiguredTreasuryDependencies {
  readonly chains: ChainRepository;
  readonly treasuries: TreasuryRepository;
}

export interface RegisterConfiguredTreasuryInput {
  readonly chain: ChainRegistration;
  /** Lowercase address, used as the storage key. */
  readonly treasuryAddress: string;
  /** EIP-55 checksummed form, for display. */
  readonly treasuryAddressDisplay: string;
  readonly kind: TreasuryKind;
  readonly thresholds: TreasuryThresholds;
  readonly policy: TreasuryFundingPolicyAmounts | undefined;
}

export interface RegisteredChainTreasuries {
  readonly chainId: number;
  readonly external: Treasury;
  readonly operational: Treasury | undefined;
}

export interface RegisterConfiguredTreasuriesResult {
  readonly chains: readonly RegisteredChainTreasuries[];
}

export interface RegisteredTreasurySummary {
  readonly chainId: number;
  readonly treasuryId: string;
  readonly operationalTreasuryId: string | undefined;
}

/** One heartbeat entry per configured chain. Never collapses to the first chain. */
export function summarizeRegisteredTreasuries(
  registered: RegisterConfiguredTreasuriesResult,
): readonly RegisteredTreasurySummary[] {
  return registered.chains.map((entry) => ({
    chainId: entry.chainId,
    treasuryId: entry.external.id,
    operationalTreasuryId: entry.operational?.id,
  }));
}

export function requireRegisteredChain(
  registered: RegisterConfiguredTreasuriesResult,
  chainId: number,
): RegisteredChainTreasuries {
  const match = registered.chains.find((entry) => entry.chainId === chainId);
  if (match === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `No treasury was registered for chain ${String(chainId)}`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }
  return match;
}

/**
 * Reconciles the configured chain and treasury into the database.
 *
 * Configuration is the source of truth for which treasury exists and what its
 * thresholds are; the database holds observed state. Running this on every boot
 * and every cron run is idempotent and keeps a threshold change in the
 * environment from requiring a manual database edit.
 */
export async function registerConfiguredTreasury(
  dependencies: RegisterConfiguredTreasuryDependencies,
  input: RegisterConfiguredTreasuryInput,
): Promise<Treasury> {
  assertValidTreasuryThresholds(input.thresholds);

  const chain = await dependencies.chains.upsert(input.chain);

  return dependencies.treasuries.upsert({
    chainRowId: chain.id,
    address: input.treasuryAddress,
    addressDisplay: input.treasuryAddressDisplay,
    kind: input.kind,
    thresholds: input.thresholds,
    policy: input.policy,
  });
}

/**
 * Bootstraps the Public treasury of every configured chain and, when two-tier
 * is enabled, that chain's Private operational treasury (C23). Mode is
 * process-global (D16), so either every chain has an operational row or none do.
 */
export async function registerConfiguredTreasuries(
  dependencies: RegisterConfiguredTreasuryDependencies,
  config: Pick<ChainBankConfig, 'chains'>,
): Promise<RegisterConfiguredTreasuriesResult> {
  const chains: RegisteredChainTreasuries[] = [];

  for (const configured of config.chains) {
    chains.push(await registerChainTreasuries(dependencies, configured));
  }

  return { chains };
}

async function registerChainTreasuries(
  dependencies: RegisterConfiguredTreasuryDependencies,
  configured: ConfiguredChain,
): Promise<RegisteredChainTreasuries> {
  const chain: ChainRegistration = {
    slug: configured.slug,
    chainId: configured.chainId,
    displayName: configured.displayName,
    nativeSymbol: configured.nativeSymbol,
    explorerBaseUrl: configured.explorerBaseUrl,
  };

  const external = await registerConfiguredTreasury(dependencies, {
    chain,
    treasuryAddress: configured.treasury.address.toLowerCase(),
    treasuryAddressDisplay: configured.treasury.address,
    kind: 'external',
    thresholds: {
      warningBalanceWei: configured.treasury.warningBalanceWei,
      criticalBalanceWei: configured.treasury.criticalBalanceWei,
      recoveryBalanceWei: configured.treasury.recoveryBalanceWei,
      minimumReserveWei: configured.treasury.minimumReserveWei,
    },
    policy: undefined,
  });

  if (configured.operationalTreasury === undefined) {
    return { chainId: configured.chainId, external, operational: undefined };
  }

  const operational = await registerConfiguredTreasury(dependencies, {
    chain,
    treasuryAddress: configured.operationalTreasury.address.toLowerCase(),
    treasuryAddressDisplay: configured.operationalTreasury.address,
    kind: 'operational',
    thresholds: {
      warningBalanceWei: configured.operationalTreasury.warningBalanceWei,
      criticalBalanceWei: configured.operationalTreasury.criticalBalanceWei,
      recoveryBalanceWei: configured.operationalTreasury.recoveryBalanceWei,
      minimumReserveWei: configured.operationalTreasury.minimumReserveWei,
    },
    policy: configured.operationalTreasury.policy,
  });

  return { chainId: configured.chainId, external, operational };
}
