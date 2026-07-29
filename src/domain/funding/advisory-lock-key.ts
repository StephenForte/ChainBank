/**
 * Derives a stable pair of int4 keys for `pg_advisory_xact_lock(key1, key2)`.
 *
 * Decision D7: one dispatcher per (treasury, chain). Keys are derived from the
 * treasury UUID and EVM chain ID so concurrent connections serialize without a
 * separate lock table.
 *
 * Postgres `hashtext` is used at the SQL boundary for the UUID; the EVM chain
 * ID is used directly (fits int4 for all supported chains).
 */

export interface FundingAdvisoryLockKey {
  /** Bound as the first argument to pg_advisory_xact_lock (via hashtext in SQL). */
  readonly treasuryId: string;
  /** Bound as the second int4 argument to pg_advisory_xact_lock. */
  readonly evmChainId: number;
}

export function fundingAdvisoryLockKey(treasuryId: string, evmChainId: number): FundingAdvisoryLockKey {
  if (!Number.isInteger(evmChainId) || evmChainId <= 0) {
    throw new Error(`evmChainId must be a positive integer, received ${String(evmChainId)}`);
  }
  if (treasuryId.trim() === '') {
    throw new Error('treasuryId must be a non-empty string');
  }
  return { treasuryId, evmChainId };
}
