import type { ChainBankConfig } from '../../config/index.js';
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

export interface RegisterConfiguredTreasuriesResult {
  readonly external: Treasury;
  readonly operational: Treasury | undefined;
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
 * Bootstraps the configured Public treasury and, when two-tier is enabled,
 * the Private operational treasury (C23).
 */
export async function registerConfiguredTreasuries(
  dependencies: RegisterConfiguredTreasuryDependencies,
  config: Pick<ChainBankConfig, 'chain' | 'treasury' | 'operationalTreasury'>,
): Promise<RegisterConfiguredTreasuriesResult> {
  const chain: ChainRegistration = {
    slug: config.chain.slug,
    chainId: config.chain.chainId,
    displayName: config.chain.displayName,
    nativeSymbol: config.chain.nativeSymbol,
    explorerBaseUrl: config.chain.explorerBaseUrl,
  };

  const external = await registerConfiguredTreasury(dependencies, {
    chain,
    treasuryAddress: config.treasury.address.toLowerCase(),
    treasuryAddressDisplay: config.treasury.address,
    kind: 'external',
    thresholds: {
      warningBalanceWei: config.treasury.warningBalanceWei,
      criticalBalanceWei: config.treasury.criticalBalanceWei,
      recoveryBalanceWei: config.treasury.recoveryBalanceWei,
      minimumReserveWei: config.treasury.minimumReserveWei,
    },
    policy: undefined,
  });

  if (config.operationalTreasury === undefined) {
    return { external, operational: undefined };
  }

  const operational = await registerConfiguredTreasury(dependencies, {
    chain,
    treasuryAddress: config.operationalTreasury.address.toLowerCase(),
    treasuryAddressDisplay: config.operationalTreasury.address,
    kind: 'operational',
    thresholds: {
      warningBalanceWei: config.operationalTreasury.warningBalanceWei,
      criticalBalanceWei: config.operationalTreasury.criticalBalanceWei,
      recoveryBalanceWei: config.operationalTreasury.recoveryBalanceWei,
      minimumReserveWei: config.operationalTreasury.minimumReserveWei,
    },
    policy: config.operationalTreasury.policy,
  });

  return { external, operational };
}
