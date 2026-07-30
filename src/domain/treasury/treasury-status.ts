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
 * Thresholds form a ladder: reserve < critical <= warning <= recovery. The gap
 * between warning and recovery is deliberate hysteresis so a balance hovering at
 * the boundary cannot flap between alerting and resolved.
 *
 * The reserve rule exists because funding cannot spend below the reserve, so a
 * reserve at or above the critical threshold means the balance can never fall
 * far enough for the critical alert to fire through ordinary funding activity.
 * The operator's most urgent signal would be stranded, and funding would begin
 * refusing requests while the treasury still reported `warning`. Enforced here
 * rather than only in CI so a local `.env` or a dashboard override cannot start
 * a service with unreachable escalation.
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
  if (thresholds.minimumReserveWei >= thresholds.criticalBalanceWei) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'minimumReserveWei must be strictly less than criticalBalanceWei, otherwise funding ' +
        'stops before the balance can fall to the critical threshold and the critical alert ' +
        'can never fire from funding activity',
      { publicMessage: 'Minimum reserve must be below the critical threshold.' },
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
