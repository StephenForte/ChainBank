import { assertValidTreasuryThresholds, type TreasuryThresholds } from '../../domain/treasury/treasury-status.js';
import type { ChainRegistration, ChainRepository, Treasury, TreasuryRepository } from '../ports.js';

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
  readonly thresholds: TreasuryThresholds;
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
    thresholds: input.thresholds,
  });
}
