import { ChainBankError } from '../errors.js';
import { assertNonNegativeWei } from '../wei.js';

/**
 * `unknown` exists so an RPC failure can never be rendered as a zero balance.
 * It is a distinct state, not a degenerate `critical`.
 */
export type TreasuryStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface TreasuryThresholds {
  readonly warningBalanceWei: bigint;
  readonly criticalBalanceWei: bigint;
  readonly recoveryBalanceWei: bigint;
  readonly minimumReserveWei: bigint;
}

/**
 * Thresholds form a ladder: critical <= warning <= recovery. The gap between
 * warning and recovery is deliberate hysteresis so a balance hovering at the
 * boundary cannot flap between alerting and resolved.
 */
export function assertValidTreasuryThresholds(thresholds: TreasuryThresholds): void {
  assertNonNegativeWei(thresholds.criticalBalanceWei, 'criticalBalanceWei');
  assertNonNegativeWei(thresholds.warningBalanceWei, 'warningBalanceWei');
  assertNonNegativeWei(thresholds.recoveryBalanceWei, 'recoveryBalanceWei');
  assertNonNegativeWei(thresholds.minimumReserveWei, 'minimumReserveWei');

  if (thresholds.criticalBalanceWei > thresholds.warningBalanceWei) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'criticalBalanceWei must be less than or equal to warningBalanceWei',
      { publicMessage: 'Critical threshold must not exceed the warning threshold.' },
    );
  }
  if (thresholds.warningBalanceWei > thresholds.recoveryBalanceWei) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'warningBalanceWei must be less than or equal to recoveryBalanceWei',
      { publicMessage: 'Warning threshold must not exceed the recovery threshold.' },
    );
  }
}

/**
 * Classifies an observed balance. Callers must only reach this with a balance
 * that was actually read from the chain; an unavailable read stays `unknown`.
 */
export function evaluateTreasuryStatus(balanceWei: bigint, thresholds: TreasuryThresholds): TreasuryStatus {
  assertNonNegativeWei(balanceWei, 'balanceWei');
  if (balanceWei <= thresholds.criticalBalanceWei) {
    return 'critical';
  }
  if (balanceWei <= thresholds.warningBalanceWei) {
    return 'warning';
  }
  return 'healthy';
}

/**
 * Spendable balance is what remains above the reserve. Phase 0 only reports
 * this; the reserve is enforced against real transfers from Phase 1 onward.
 */
export function calculateSpendableWei(balanceWei: bigint, thresholds: TreasuryThresholds): bigint {
  assertNonNegativeWei(balanceWei, 'balanceWei');
  const spendable = balanceWei - thresholds.minimumReserveWei;
  return spendable > 0n ? spendable : 0n;
}
