import { ChainBankError } from '../errors.js';
import { assertValidTreasuryThresholds, type TreasuryThresholds } from '../treasury/treasury-status.js';
import { assertNonNegativeWei } from '../wei.js';

export type AlertSeverity = 'warning' | 'critical';

/**
 * Persisted open-alert projection used by evaluation and cron persistence.
 * Resolved alerts are represented as `undefined` rather than a closed record.
 */
export interface OpenAlertState {
  readonly severity: AlertSeverity;
  readonly firstTriggeredAt: Date;
  readonly lastSentAt: Date;
}

export type AlertTransition =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly severity: AlertSeverity }
  | { readonly kind: 'escalate' }
  | { readonly kind: 'remind' }
  | { readonly kind: 'resolve' };

type AlertBalanceBand = 'recovered' | 'intermediate' | 'warning' | 'critical';

/**
 * Pure treasury alert transitions (PRD P3-US2 / P3-US3).
 *
 * Exactly one email-worthy transition per state change; repeated checks in an
 * unchanged band yield `none` until the reminder interval elapses. Recovery
 * uses hysteresis: an open alert resolves only at/above `recoveryBalanceWei`,
 * not merely above the warning threshold.
 */
export function evaluateTreasuryAlert(input: {
  readonly balanceWei: bigint;
  readonly thresholds: TreasuryThresholds;
  readonly openAlert: OpenAlertState | undefined;
  readonly now: Date;
  readonly reminderIntervalMs: number;
}): AlertTransition {
  assertNonNegativeWei(input.balanceWei, 'balanceWei');
  assertValidTreasuryThresholds(input.thresholds);
  assertValidReminderIntervalMs(input.reminderIntervalMs);

  const band = classifyAlertBalanceBand(input.balanceWei, input.thresholds);

  if (input.openAlert === undefined) {
    if (band === 'critical') {
      return { kind: 'open', severity: 'critical' };
    }
    if (band === 'warning') {
      return { kind: 'open', severity: 'warning' };
    }
    return { kind: 'none' };
  }

  if (band === 'recovered') {
    return { kind: 'resolve' };
  }

  if (input.openAlert.severity === 'warning' && band === 'critical') {
    return { kind: 'escalate' };
  }

  if (isReminderDue(input.openAlert.lastSentAt, input.now, input.reminderIntervalMs)) {
    return { kind: 'remind' };
  }

  return { kind: 'none' };
}

/**
 * Applies a transition to open-alert state for persistence.
 *
 * Email-sending transitions (`open`, `escalate`, `remind`) advance `lastSentAt`
 * to `now`. `resolve` clears the open alert. `none` is a no-op.
 */
export function applyAlertTransition(
  openAlert: OpenAlertState | undefined,
  transition: AlertTransition,
  now: Date,
): OpenAlertState | undefined {
  switch (transition.kind) {
    case 'none':
      return openAlert;
    case 'open':
      return {
        severity: transition.severity,
        firstTriggeredAt: now,
        lastSentAt: now,
      };
    case 'escalate': {
      if (openAlert === undefined) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Cannot escalate without an open warning alert', {
          publicMessage: 'Alert state is inconsistent.',
        });
      }
      if (openAlert.severity !== 'warning') {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          'Cannot escalate an alert that is not currently warning',
          { publicMessage: 'Alert state is inconsistent.' },
        );
      }
      return {
        severity: 'critical',
        firstTriggeredAt: openAlert.firstTriggeredAt,
        lastSentAt: now,
      };
    }
    case 'remind': {
      if (openAlert === undefined) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Cannot remind without an open alert', {
          publicMessage: 'Alert state is inconsistent.',
        });
      }
      return {
        severity: openAlert.severity,
        firstTriggeredAt: openAlert.firstTriggeredAt,
        lastSentAt: now,
      };
    }
    case 'resolve':
      if (openAlert === undefined) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Cannot resolve without an open alert', {
          publicMessage: 'Alert state is inconsistent.',
        });
      }
      return undefined;
    default: {
      const _exhaustive: never = transition;
      throw new ChainBankError(
        'INVALID_CONFIGURATION',
        `Unhandled alert transition: ${JSON.stringify(_exhaustive)}`,
        { publicMessage: 'Alert state is inconsistent.' },
      );
    }
  }
}

function classifyAlertBalanceBand(balanceWei: bigint, thresholds: TreasuryThresholds): AlertBalanceBand {
  // Recovery wins over warning/critical classification so equal recovery and
  // warning thresholds cannot open then immediately resolve on the next tick.
  if (balanceWei >= thresholds.recoveryBalanceWei) {
    return 'recovered';
  }
  if (balanceWei <= thresholds.criticalBalanceWei) {
    return 'critical';
  }
  if (balanceWei <= thresholds.warningBalanceWei) {
    return 'warning';
  }
  return 'intermediate';
}

function isReminderDue(lastSentAt: Date, now: Date, reminderIntervalMs: number): boolean {
  return now.getTime() - lastSentAt.getTime() >= reminderIntervalMs;
}

function assertValidReminderIntervalMs(reminderIntervalMs: number): void {
  if (!Number.isFinite(reminderIntervalMs) || reminderIntervalMs < 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'reminderIntervalMs must be a finite non-negative number',
      { publicMessage: 'Reminder interval is not valid.' },
    );
  }
}
