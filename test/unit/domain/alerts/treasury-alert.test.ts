import { describe, expect, it } from 'vitest';
import {
  applyAlertTransition,
  evaluateTreasuryAlert,
  type AlertTransition,
  type OpenAlertState,
} from '../../../../src/domain/alerts/index.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import type { TreasuryThresholds } from '../../../../src/domain/treasury/treasury-status.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const thresholds: TreasuryThresholds = {
  criticalBalanceWei: 25n,
  warningBalanceWei: 100n,
  recoveryBalanceWei: 200n,
  minimumReserveWei: 50n,
};

const t0 = new Date('2026-07-28T12:00:00.000Z');

function openAlert(
  severity: OpenAlertState['severity'],
  lastSentAt: Date = t0,
  firstTriggeredAt: Date = lastSentAt,
): OpenAlertState {
  return { severity, firstTriggeredAt, lastSentAt };
}

function evaluate(input: {
  readonly balanceWei: bigint;
  readonly openAlert?: OpenAlertState | undefined;
  readonly now?: Date;
  readonly reminderIntervalMs?: number;
  readonly thresholds?: TreasuryThresholds;
}): AlertTransition {
  return evaluateTreasuryAlert({
    balanceWei: input.balanceWei,
    thresholds: input.thresholds ?? thresholds,
    openAlert: input.openAlert,
    now: input.now ?? t0,
    reminderIntervalMs: input.reminderIntervalMs ?? DAY_MS,
  });
}

function expectIdempotentAfterApply(
  balanceWei: bigint,
  initialOpen: OpenAlertState | undefined,
  expected: AlertTransition,
  now: Date = t0,
): OpenAlertState | undefined {
  const transition = evaluate({ balanceWei, openAlert: initialOpen, now });
  expect(transition).toEqual(expected);
  const next = applyAlertTransition(initialOpen, transition, now);
  expect(evaluate({ balanceWei, openAlert: next, now })).toEqual({ kind: 'none' });
  return next;
}

describe('evaluateTreasuryAlert', () => {
  describe('lifecycle healthy → warning → critical → recovery', () => {
    it('opens warning, escalates to critical, then resolves at recovery', () => {
      let state = expectIdempotentAfterApply(100n, undefined, {
        kind: 'open',
        severity: 'warning',
      });
      expect(state).toEqual(openAlert('warning', t0));

      const afterWarningHold = evaluate({
        balanceWei: 80n,
        openAlert: state,
        now: new Date(t0.getTime() + HOUR_MS),
      });
      expect(afterWarningHold).toEqual({ kind: 'none' });

      const escalateAt = new Date(t0.getTime() + 2 * HOUR_MS);
      state = expectIdempotentAfterApply(25n, state, { kind: 'escalate' }, escalateAt);
      expect(state).toEqual({
        severity: 'critical',
        firstTriggeredAt: t0,
        lastSentAt: escalateAt,
      });

      const recoverAt = new Date(escalateAt.getTime() + HOUR_MS);
      state = expectIdempotentAfterApply(200n, state, { kind: 'resolve' }, recoverAt);
      expect(state).toBeUndefined();
    });
  });

  describe('direct healthy → critical', () => {
    it('opens critical without a warning step', () => {
      const state = expectIdempotentAfterApply(10n, undefined, {
        kind: 'open',
        severity: 'critical',
      });
      expect(state?.severity).toBe('critical');
    });
  });

  describe('repeated checks', () => {
    it('sends nothing while healthy with no open alert', () => {
      expect(evaluate({ balanceWei: 201n })).toEqual({ kind: 'none' });
      expect(evaluate({ balanceWei: 150n })).toEqual({ kind: 'none' });
    });

    it('sends nothing for repeated warning checks before reminder interval', () => {
      const state = openAlert('warning', t0);
      expect(
        evaluate({
          balanceWei: 80n,
          openAlert: state,
          now: new Date(t0.getTime() + DAY_MS - 1),
        }),
      ).toEqual({ kind: 'none' });
    });

    it('sends nothing for repeated critical checks before reminder interval', () => {
      const state = openAlert('critical', t0);
      expect(
        evaluate({
          balanceWei: 10n,
          openAlert: state,
          now: new Date(t0.getTime() + DAY_MS - 1),
        }),
      ).toEqual({ kind: 'none' });
    });
  });

  describe('reminder', () => {
    it('fires exactly once per interval for an unresolved warning', () => {
      const state = openAlert('warning', t0);
      const dueAt = new Date(t0.getTime() + DAY_MS);
      const reminded = expectIdempotentAfterApply(80n, state, { kind: 'remind' }, dueAt);
      expect(reminded?.lastSentAt).toEqual(dueAt);

      expect(
        evaluate({
          balanceWei: 80n,
          openAlert: reminded,
          now: new Date(dueAt.getTime() + DAY_MS - 1),
        }),
      ).toEqual({ kind: 'none' });

      const nextDue = new Date(dueAt.getTime() + DAY_MS);
      expectIdempotentAfterApply(80n, reminded, { kind: 'remind' }, nextDue);
    });

    it('fires for unresolved critical past the interval', () => {
      const state = openAlert('critical', t0);
      expectIdempotentAfterApply(10n, state, { kind: 'remind' }, new Date(t0.getTime() + DAY_MS));
    });

    it('reminder does not fire when recovery is due', () => {
      const state = openAlert('critical', t0);
      expect(
        evaluate({
          balanceWei: 200n,
          openAlert: state,
          now: new Date(t0.getTime() + DAY_MS),
        }),
      ).toEqual({ kind: 'resolve' });
    });

    it('escalate takes priority over reminder when warning drops to critical', () => {
      const state = openAlert('warning', t0);
      expect(
        evaluate({
          balanceWei: 25n,
          openAlert: state,
          now: new Date(t0.getTime() + DAY_MS),
        }),
      ).toEqual({ kind: 'escalate' });
    });
  });

  describe('balance exactly equal to each threshold', () => {
    it('treats balance equal to critical as critical', () => {
      expect(evaluate({ balanceWei: 25n })).toEqual({ kind: 'open', severity: 'critical' });
    });

    it('treats balance equal to warning as warning when recovery is higher', () => {
      expect(evaluate({ balanceWei: 100n })).toEqual({ kind: 'open', severity: 'warning' });
    });

    it('treats balance equal to recovery as recovered (no open / resolve)', () => {
      expect(evaluate({ balanceWei: 200n })).toEqual({ kind: 'none' });
      expect(
        evaluate({
          balanceWei: 200n,
          openAlert: openAlert('warning', t0),
        }),
      ).toEqual({ kind: 'resolve' });
    });

    it('keeps an open alert in the hysteresis band between warning and recovery', () => {
      const state = openAlert('warning', t0);
      expect(evaluate({ balanceWei: 150n, openAlert: state })).toEqual({ kind: 'none' });
      expect(evaluate({ balanceWei: 101n, openAlert: state })).toEqual({ kind: 'none' });
      expect(evaluate({ balanceWei: 199n, openAlert: state })).toEqual({ kind: 'none' });
    });

    it('does not de-escalate critical when balance rises only into warning band', () => {
      const state = openAlert('critical', t0);
      expect(evaluate({ balanceWei: 80n, openAlert: state })).toEqual({ kind: 'none' });
      expect(evaluate({ balanceWei: 150n, openAlert: state })).toEqual({ kind: 'none' });
    });
  });

  describe('recovery threshold equal to warning threshold', () => {
    const equalRecovery: TreasuryThresholds = {
      ...thresholds,
      recoveryBalanceWei: 100n,
    };

    it('does not open at the shared threshold (recovery wins)', () => {
      expect(
        evaluate({
          balanceWei: 100n,
          thresholds: equalRecovery,
        }),
      ).toEqual({ kind: 'none' });
    });

    it('opens warning only strictly below the shared threshold', () => {
      expect(
        evaluate({
          balanceWei: 99n,
          thresholds: equalRecovery,
        }),
      ).toEqual({ kind: 'open', severity: 'warning' });
    });

    it('resolves an open alert at the shared threshold', () => {
      expect(
        evaluate({
          balanceWei: 100n,
          thresholds: equalRecovery,
          openAlert: openAlert('warning', t0),
        }),
      ).toEqual({ kind: 'resolve' });
    });
  });

  describe('invalid threshold ordering', () => {
    it('rejects critical above warning', () => {
      expect(() =>
        evaluate({
          balanceWei: 50n,
          thresholds: {
            ...thresholds,
            criticalBalanceWei: 150n,
          },
        }),
      ).toThrow(ChainBankError);

      try {
        evaluate({
          balanceWei: 50n,
          thresholds: {
            ...thresholds,
            criticalBalanceWei: 150n,
          },
        });
        expect.unreachable('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ChainBankError);
        expect((error as ChainBankError).code).toBe('INVALID_CONFIGURATION');
      }
    });

    it('rejects warning above recovery', () => {
      try {
        evaluate({
          balanceWei: 50n,
          thresholds: {
            ...thresholds,
            warningBalanceWei: 250n,
          },
        });
        expect.unreachable('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ChainBankError);
        expect((error as ChainBankError).code).toBe('INVALID_CONFIGURATION');
      }
    });

    it('rejects negative balances and reminder intervals', () => {
      expect(() => evaluate({ balanceWei: -1n })).toThrow(ChainBankError);
      expect(() => evaluate({ balanceWei: 50n, reminderIntervalMs: -1 })).toThrow(ChainBankError);
      expect(() => evaluate({ balanceWei: 50n, reminderIntervalMs: Number.NaN })).toThrow(ChainBankError);
    });
  });

  describe('duplicate evaluation idempotency', () => {
    it('same inputs always yield the same transition', () => {
      const input = {
        balanceWei: 80n,
        openAlert: openAlert('warning', t0),
        now: new Date(t0.getTime() + DAY_MS),
      };
      expect(evaluate(input)).toEqual(evaluate(input));
      expect(evaluate(input)).toEqual({ kind: 'remind' });
    });
  });
});

describe('applyAlertTransition', () => {
  it('returns the same open alert for none', () => {
    const state = openAlert('warning', t0);
    expect(applyAlertTransition(state, { kind: 'none' }, t0)).toBe(state);
    expect(applyAlertTransition(undefined, { kind: 'none' }, t0)).toBeUndefined();
  });

  it('opens warning and critical states at now', () => {
    expect(applyAlertTransition(undefined, { kind: 'open', severity: 'warning' }, t0)).toEqual(
      openAlert('warning', t0),
    );
    expect(applyAlertTransition(undefined, { kind: 'open', severity: 'critical' }, t0)).toEqual(
      openAlert('critical', t0),
    );
  });

  it('escalates warning to critical and advances lastSentAt', () => {
    const opened = openAlert('warning', t0);
    const later = new Date(t0.getTime() + HOUR_MS);
    expect(applyAlertTransition(opened, { kind: 'escalate' }, later)).toEqual({
      severity: 'critical',
      firstTriggeredAt: t0,
      lastSentAt: later,
    });
  });

  it('reminds by advancing lastSentAt only', () => {
    const opened = openAlert('critical', t0);
    const later = new Date(t0.getTime() + DAY_MS);
    expect(applyAlertTransition(opened, { kind: 'remind' }, later)).toEqual({
      severity: 'critical',
      firstTriggeredAt: t0,
      lastSentAt: later,
    });
  });

  it('resolves by clearing open state', () => {
    expect(applyAlertTransition(openAlert('warning', t0), { kind: 'resolve' }, t0)).toBeUndefined();
  });

  it('rejects inconsistent transitions', () => {
    expect(() => applyAlertTransition(undefined, { kind: 'escalate' }, t0)).toThrow(ChainBankError);
    expect(() => applyAlertTransition(openAlert('critical', t0), { kind: 'escalate' }, t0)).toThrow(
      ChainBankError,
    );
    expect(() => applyAlertTransition(undefined, { kind: 'remind' }, t0)).toThrow(ChainBankError);
    expect(() => applyAlertTransition(undefined, { kind: 'resolve' }, t0)).toThrow(ChainBankError);
  });

  it('rejects an impossible transition kind at runtime', () => {
    const impossible = { kind: 'not-a-transition' } as unknown as AlertTransition;
    expect(() => applyAlertTransition(undefined, impossible, t0)).toThrow();
  });
});
