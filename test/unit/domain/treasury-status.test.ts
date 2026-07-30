import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';
import {
  assertValidTreasuryThresholds,
  calculateSpendableWei,
  evaluateTreasuryStatus,
  type TreasuryThresholds,
} from '../../../src/domain/treasury/treasury-status.js';

const thresholds: TreasuryThresholds = {
  criticalBalanceWei: parseEtherToWei('0.25', 'critical'),
  warningBalanceWei: parseEtherToWei('1', 'warning'),
  recoveryBalanceWei: parseEtherToWei('2', 'recovery'),
  minimumReserveWei: parseEtherToWei('0.5', 'reserve'),
};

describe('assertValidTreasuryThresholds', () => {
  it('accepts a valid critical <= warning <= recovery ladder', () => {
    expect(() => assertValidTreasuryThresholds(thresholds)).not.toThrow();
  });

  it('rejects critical above warning', () => {
    expect(() =>
      assertValidTreasuryThresholds({
        ...thresholds,
        criticalBalanceWei: parseEtherToWei('2', 'critical'),
      }),
    ).toThrow(ChainBankError);
  });

  it('rejects warning above recovery', () => {
    expect(() =>
      assertValidTreasuryThresholds({
        ...thresholds,
        warningBalanceWei: parseEtherToWei('3', 'warning'),
      }),
    ).toThrow(ChainBankError);
  });
});

/**
 * The deployed threshold ladder (decision D3), pinned so a future edit that
 * breaks the ordering fails here rather than at service startup.
 *
 * These values live in the Render environment as `sync: false`, so CI cannot
 * read them directly — what this suite guarantees is that the *rules* they were
 * chosen against stay intact, and that the specific mistakes already made stay
 * rejected.
 */
describe('deployed threshold ladder (D3)', () => {
  const deployed: TreasuryThresholds = {
    criticalBalanceWei: parseEtherToWei('0.3', 'critical'),
    warningBalanceWei: parseEtherToWei('0.75', 'warning'),
    recoveryBalanceWei: parseEtherToWei('1.5', 'recovery'),
    minimumReserveWei: parseEtherToWei('0.1', 'reserve'),
  };

  it('accepts the recommended ordering: reserve < critical < warning < recovery', () => {
    expect(() => assertValidTreasuryThresholds(deployed)).not.toThrow();

    // The property that makes the critical alert meaningful: it fires while
    // funding still has headroom, rather than after funding has already halted.
    expect(deployed.minimumReserveWei).toBeLessThan(deployed.criticalBalanceWei);
    expect(calculateSpendableWei(deployed.criticalBalanceWei, deployed)).toBeGreaterThan(0n);
  });

  it('rejects a recovery below warning — the ".15 for 1.5" typo', () => {
    // Regression: this exact pair was set in the Render environment on
    // 2026-07-29. `buildTreasuryConfig` runs unconditionally in `loadConfig`,
    // so it would have failed both the web service and the monitor cron at
    // boot, not just the funding path.
    expect(() =>
      assertValidTreasuryThresholds({
        ...deployed,
        recoveryBalanceWei: parseEtherToWei('.15', 'recovery'),
      }),
    ).toThrow(/recoveryBalanceWei/);
  });

  it('treats a leading-dot decimal as equivalent to its padded form', () => {
    // `.75` and `0.75` must parse identically, so the shorthand an operator
    // types in a dashboard field is never itself the cause of a rejection.
    expect(parseEtherToWei('.75', 'warning')).toBe(parseEtherToWei('0.75', 'warning'));
    expect(parseEtherToWei('.15', 'recovery')).toBe(parseEtherToWei('0.15', 'recovery'));
  });

  it('allows the boundary cases where adjacent thresholds are equal', () => {
    // The validator compares with `>`, so equality is permitted. Pinned because
    // tightening these to `>=` would reject legitimate flat ladders.
    expect(() =>
      assertValidTreasuryThresholds({
        ...deployed,
        criticalBalanceWei: deployed.warningBalanceWei,
      }),
    ).not.toThrow();
    expect(() =>
      assertValidTreasuryThresholds({
        ...deployed,
        recoveryBalanceWei: deployed.warningBalanceWei,
      }),
    ).not.toThrow();
  });

  it('rejects a negative value in any threshold', () => {
    for (const field of [
      'criticalBalanceWei',
      'warningBalanceWei',
      'recoveryBalanceWei',
      'minimumReserveWei',
    ] as const) {
      expect(() => assertValidTreasuryThresholds({ ...deployed, [field]: -1n })).toThrow(ChainBankError);
    }
  });

  it('still accepts a reserve at or above critical, which strands the critical alert', () => {
    // Not a validation error, and deliberately not made one: the original
    // deployed ladder (reserve 0.5, critical 0.25) had this shape and worked.
    // The consequence is that funding halts before the balance can reach
    // critical, so the critical email stops being the "funding is about to
    // stop" signal. Documented in the D3 note in tasks/DECISIONS.md.
    const strandedCritical: TreasuryThresholds = {
      criticalBalanceWei: parseEtherToWei('0.25', 'critical'),
      warningBalanceWei: parseEtherToWei('1', 'warning'),
      recoveryBalanceWei: parseEtherToWei('2', 'recovery'),
      minimumReserveWei: parseEtherToWei('0.5', 'reserve'),
    };

    expect(() => assertValidTreasuryThresholds(strandedCritical)).not.toThrow();
    // Proof of the interaction: nothing is spendable by the time the balance
    // has fallen to the critical threshold.
    expect(calculateSpendableWei(strandedCritical.criticalBalanceWei, strandedCritical)).toBe(0n);
  });
});

describe('evaluateTreasuryStatus', () => {
  it('classifies critical, warning, and healthy balances', () => {
    expect(evaluateTreasuryStatus(parseEtherToWei('0.1', 'b'), thresholds)).toBe('critical');
    expect(evaluateTreasuryStatus(parseEtherToWei('0.25', 'b'), thresholds)).toBe('critical');
    expect(evaluateTreasuryStatus(parseEtherToWei('0.5', 'b'), thresholds)).toBe('warning');
    expect(evaluateTreasuryStatus(parseEtherToWei('1', 'b'), thresholds)).toBe('warning');
    expect(evaluateTreasuryStatus(parseEtherToWei('1.01', 'b'), thresholds)).toBe('healthy');
  });
});

describe('calculateSpendableWei', () => {
  it('returns balance above reserve and floors at zero', () => {
    expect(calculateSpendableWei(parseEtherToWei('2', 'b'), thresholds)).toBe(
      parseEtherToWei('1.5', 'expected'),
    );
    expect(calculateSpendableWei(parseEtherToWei('0.25', 'b'), thresholds)).toBe(0n);
  });
});
