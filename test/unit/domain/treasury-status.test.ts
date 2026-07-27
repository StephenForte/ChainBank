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
