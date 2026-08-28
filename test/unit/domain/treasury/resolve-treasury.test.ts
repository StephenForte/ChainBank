import { describe, expect, it } from 'vitest';
import {
  resolveFundingTreasury,
  resolveOperationalTreasury,
  resolveReplenishSource,
  throwTreasuryResolution,
  type ResolvableTreasury,
} from '../../../../src/domain/treasury/resolve-treasury.js';
import { ChainBankError } from '../../../../src/domain/errors.js';

const CHAIN = 11_155_111;

function treasury(
  overrides: Partial<ResolvableTreasury> & Pick<ResolvableTreasury, 'id' | 'kind'>,
): ResolvableTreasury {
  return {
    address: `0x${overrides.id.replaceAll('-', '').slice(0, 40).padEnd(40, '0')}`,
    enabled: true,
    chain: { chainId: CHAIN },
    ...overrides,
  };
}

describe('resolveFundingTreasury (C23)', () => {
  it('uses the sole enabled row in the legacy single-treasury hatch', () => {
    const sole = treasury({ id: 'ext-1', kind: 'external' });
    const result = resolveFundingTreasury([sole], CHAIN);
    expect(result).toEqual({ kind: 'ok', treasury: sole });
  });

  it('selects the operational treasury when both kinds are enabled', () => {
    const external = treasury({ id: 'ext-1', kind: 'external' });
    const operational = treasury({ id: 'op-1', kind: 'operational' });
    const result = resolveFundingTreasury([external, operational], CHAIN);
    expect(result).toEqual({ kind: 'ok', treasury: operational });
  });

  it('ignores disabled rows when selecting the funding treasury', () => {
    const disabledOp = treasury({ id: 'op-old', kind: 'operational', enabled: false });
    const external = treasury({ id: 'ext-1', kind: 'external' });
    const result = resolveFundingTreasury([disabledOp, external], CHAIN);
    expect(result).toEqual({ kind: 'ok', treasury: external });
  });

  it('refuses two enabled external rows on the same chain', () => {
    const result = resolveFundingTreasury(
      [treasury({ id: 'ext-1', kind: 'external' }), treasury({ id: 'ext-2', kind: 'external' })],
      CHAIN,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('INVALID_CONFIGURATION');
      expect(result.error.context.treasuryKind).toBe('external');
    }
  });

  it('refuses two enabled operational rows on the same chain', () => {
    const result = resolveFundingTreasury(
      [treasury({ id: 'op-1', kind: 'operational' }), treasury({ id: 'op-2', kind: 'operational' })],
      CHAIN,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('INVALID_CONFIGURATION');
      expect(result.error.context.treasuryKind).toBe('operational');
    }
  });

  it('returns TREASURY_NOT_FOUND when no enabled row exists on the chain', () => {
    const result = resolveFundingTreasury(
      [treasury({ id: 'ext-1', kind: 'external', chain: { chainId: 1 } })],
      CHAIN,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TREASURY_NOT_FOUND');
    }
  });
});

describe('resolveReplenishSource (C23)', () => {
  it('selects the enabled external treasury', () => {
    const external = treasury({ id: 'ext-1', kind: 'external' });
    const operational = treasury({ id: 'op-1', kind: 'operational' });
    expect(resolveReplenishSource([external, operational], CHAIN)).toEqual({
      kind: 'ok',
      treasury: external,
    });
  });

  it('fails when no external treasury is enabled', () => {
    const result = resolveReplenishSource([treasury({ id: 'op-1', kind: 'operational' })], CHAIN);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TREASURY_NOT_FOUND');
    }
  });
});

describe('resolveOperationalTreasury (C23)', () => {
  it('selects the enabled operational treasury', () => {
    const operational = treasury({ id: 'op-1', kind: 'operational' });
    expect(resolveOperationalTreasury([operational], CHAIN)).toEqual({
      kind: 'ok',
      treasury: operational,
    });
  });

  it('fails in the legacy hatch where only an external row exists', () => {
    const result = resolveOperationalTreasury([treasury({ id: 'ext-1', kind: 'external' })], CHAIN);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TREASURY_NOT_FOUND');
    }
  });
});

describe('throwTreasuryResolution', () => {
  it('throws ChainBankError for a resolution error', () => {
    expect(() => throwTreasuryResolution(resolveFundingTreasury([], CHAIN))).toThrow(ChainBankError);
  });
});
