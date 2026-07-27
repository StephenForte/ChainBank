import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  formatWeiAsEther,
  parseEtherToWei,
  WEI_PER_ETHER,
  weiFromDatabaseNumeric,
  weiToDatabaseNumeric,
} from '../../../src/domain/wei.js';

describe('parseEtherToWei', () => {
  it('parses whole ether amounts', () => {
    expect(parseEtherToWei('1', 'amount')).toBe(WEI_PER_ETHER);
    expect(parseEtherToWei('0', 'amount')).toBe(0n);
  });

  it('parses fractional ether without floating point', () => {
    expect(parseEtherToWei('0.5', 'amount')).toBe(WEI_PER_ETHER / 2n);
    expect(parseEtherToWei('.5', 'amount')).toBe(WEI_PER_ETHER / 2n);
    expect(parseEtherToWei('.25', 'amount')).toBe(WEI_PER_ETHER / 4n);
    expect(parseEtherToWei('1.000000000000000001', 'amount')).toBe(WEI_PER_ETHER + 1n);
  });

  it('rejects more than 18 decimal places', () => {
    expect(() => parseEtherToWei('1.0000000000000000001', 'amount')).toThrow(ChainBankError);
  });

  it('rejects negative and non-decimal input', () => {
    expect(() => parseEtherToWei('-1', 'amount')).toThrow(ChainBankError);
    expect(() => parseEtherToWei('1e18', 'amount')).toThrow(ChainBankError);
    expect(() => parseEtherToWei('abc', 'amount')).toThrow(ChainBankError);
  });
});

describe('formatWeiAsEther', () => {
  it('formats whole and fractional values for display only', () => {
    expect(formatWeiAsEther(0n)).toBe('0');
    expect(formatWeiAsEther(WEI_PER_ETHER)).toBe('1');
    expect(formatWeiAsEther(WEI_PER_ETHER / 2n)).toBe('0.5');
    expect(formatWeiAsEther(WEI_PER_ETHER + 1n)).toBe('1.000000000000000001');
  });
});

describe('database numeric conversion', () => {
  it('round-trips integer wei strings', () => {
    const value = 123456789012345678901234567890n;
    const stored = weiToDatabaseNumeric(value, 'balance');
    expect(stored).toBe(value.toString());
    expect(weiFromDatabaseNumeric(stored, 'balance')).toBe(value);
  });

  it('rejects non-integer database values instead of truncating', () => {
    expect(() => weiFromDatabaseNumeric('1.5', 'balance')).toThrow(ChainBankError);
  });
});
