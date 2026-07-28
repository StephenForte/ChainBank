import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../../src/domain/errors.js';
import {
  calculateTopUp,
  calculateTreasurySpendableWei,
  validatePolicy,
  type FundingPolicy,
} from '../../../../src/domain/funding/index.js';

const WEI_256 = 2n ** 256n - 1n;

function policy(overrides: Partial<FundingPolicy> = {}): FundingPolicy {
  return {
    minimumBalanceWei: 100n,
    targetBalanceWei: 200n,
    maximumTopUpWei: 150n,
    isEnabled: true,
    ...overrides,
  };
}

describe('validatePolicy', () => {
  it('accepts a valid policy including target equal to minimum', () => {
    const result = validatePolicy({
      minimumBalanceWei: 50n,
      targetBalanceWei: 50n,
      maximumTopUpWei: 1n,
      isEnabled: true,
    });
    expect(result).toEqual({
      ok: true,
      policy: {
        minimumBalanceWei: 50n,
        targetBalanceWei: 50n,
        maximumTopUpWei: 1n,
        isEnabled: true,
      },
    });
  });

  it('accepts target above minimum and preserves isEnabled false', () => {
    const result = validatePolicy({
      minimumBalanceWei: 10n,
      targetBalanceWei: 20n,
      maximumTopUpWei: 5n,
      isEnabled: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.isEnabled).toBe(false);
    }
  });

  it('accepts zero minimum and zero target when max top-up is positive', () => {
    const result = validatePolicy({
      minimumBalanceWei: 0n,
      targetBalanceWei: 0n,
      maximumTopUpWei: 1n,
      isEnabled: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects negative minimumBalanceWei', () => {
    const result = validatePolicy({
      minimumBalanceWei: -1n,
      targetBalanceWei: 0n,
      maximumTopUpWei: 1n,
      isEnabled: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'minimumBalanceWei must not be negative',
    });
  });

  it('rejects negative targetBalanceWei', () => {
    const result = validatePolicy({
      minimumBalanceWei: 0n,
      targetBalanceWei: -1n,
      maximumTopUpWei: 1n,
      isEnabled: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
  });

  it('rejects negative maximumTopUpWei', () => {
    const result = validatePolicy({
      minimumBalanceWei: 0n,
      targetBalanceWei: 0n,
      maximumTopUpWei: -1n,
      isEnabled: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'maximumTopUpWei must not be negative',
    });
  });

  it('rejects target below minimum', () => {
    const result = validatePolicy({
      minimumBalanceWei: 100n,
      targetBalanceWei: 99n,
      maximumTopUpWei: 1n,
      isEnabled: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_CONFIGURATION',
      message: 'targetBalanceWei must be greater than or equal to minimumBalanceWei',
    });
  });

  it('rejects zero maximumTopUpWei', () => {
    const result = validatePolicy({
      minimumBalanceWei: 10n,
      targetBalanceWei: 20n,
      maximumTopUpWei: 0n,
      isEnabled: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_CONFIGURATION',
      message: 'maximumTopUpWei must be greater than zero',
    });
  });

  it('accepts very large values near 2^256', () => {
    const result = validatePolicy({
      minimumBalanceWei: WEI_256 - 10n,
      targetBalanceWei: WEI_256,
      maximumTopUpWei: WEI_256,
      isEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.targetBalanceWei).toBe(WEI_256);
    }
  });
});

describe('calculateTreasurySpendableWei', () => {
  it('subtracts reserve and estimated cost', () => {
    expect(
      calculateTreasurySpendableWei({
        treasuryBalanceWei: 1000n,
        reserveWei: 100n,
        estimatedCostWei: 50n,
      }),
    ).toBe(850n);
  });

  it('floors at zero when reserve and cost exhaust balance', () => {
    expect(
      calculateTreasurySpendableWei({
        treasuryBalanceWei: 100n,
        reserveWei: 80n,
        estimatedCostWei: 30n,
      }),
    ).toBe(0n);
  });

  it('floors at zero when balance equals reserve plus cost', () => {
    expect(
      calculateTreasurySpendableWei({
        treasuryBalanceWei: 100n,
        reserveWei: 60n,
        estimatedCostWei: 40n,
      }),
    ).toBe(0n);
  });

  it('rejects negative inputs', () => {
    expect(() =>
      calculateTreasurySpendableWei({
        treasuryBalanceWei: -1n,
        reserveWei: 0n,
        estimatedCostWei: 0n,
      }),
    ).toThrow(ChainBankError);
    expect(() =>
      calculateTreasurySpendableWei({
        treasuryBalanceWei: 0n,
        reserveWei: -1n,
        estimatedCostWei: 0n,
      }),
    ).toThrow(ChainBankError);
    expect(() =>
      calculateTreasurySpendableWei({
        treasuryBalanceWei: 0n,
        reserveWei: 0n,
        estimatedCostWei: -1n,
      }),
    ).toThrow(ChainBankError);
  });
});

describe('calculateTopUp', () => {
  it('returns no-op when balance is exactly at minimum', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 100n,
        policy: policy(),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
  });

  it('returns no-op when balance is above minimum', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 150n,
        policy: policy(),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
  });

  it('funds the full deficit when below minimum and unconstrained', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 40n,
        policy: policy({ minimumBalanceWei: 100n, targetBalanceWei: 200n, maximumTopUpWei: 500n }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 160n });
  });

  it('funds toward target when target equals minimum', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 80n,
        policy: policy({
          minimumBalanceWei: 100n,
          targetBalanceWei: 100n,
          maximumTopUpWei: 50n,
        }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 20n });
  });

  it('clamps by maximumTopUp when maximum is smaller than deficit', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({
          minimumBalanceWei: 100n,
          targetBalanceWei: 200n,
          maximumTopUpWei: 50n,
        }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 50n });
  });

  it('clamps by treasury spendable when spendable is the binding constraint', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({
          minimumBalanceWei: 100n,
          targetBalanceWei: 200n,
          maximumTopUpWei: 500n,
        }),
        treasurySpendableWei: 75n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 75n });
  });

  it('funds an amount that exactly exhausts spendable', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 50n,
        policy: policy({
          minimumBalanceWei: 100n,
          targetBalanceWei: 200n,
          maximumTopUpWei: 200n,
        }),
        treasurySpendableWei: 150n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 150n });
  });

  it('blocks on reserve when spendable is zero', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy(),
        treasurySpendableWei: 0n,
      }),
    ).toEqual({ kind: 'blocked', reason: 'reserve' });
  });

  it('blocks on reserve when spendable clamps the amount to zero', () => {
    // Binding path already covered by zero spendable; confirm order still yields reserve.
    expect(
      calculateTopUp({
        currentBalanceWei: 99n,
        policy: policy({ maximumTopUpWei: 1n, targetBalanceWei: 100n }),
        treasurySpendableWei: 0n,
      }),
    ).toEqual({ kind: 'blocked', reason: 'reserve' });
  });

  it('blocks when policy is disabled even if funding would otherwise apply', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({ isEnabled: false }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'blocked', reason: 'policy-disabled' });
  });

  it('blocks with max-top-up-zero when maximumTopUpWei is zero', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({ maximumTopUpWei: 0n }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'blocked', reason: 'max-top-up-zero' });
  });

  it('prefers policy-disabled over max-top-up-zero when both apply', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({ isEnabled: false, maximumTopUpWei: 0n }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'blocked', reason: 'policy-disabled' });
  });

  it('returns no-op at minimum even when policy is disabled', () => {
    expect(
      calculateTopUp({
        currentBalanceWei: 100n,
        policy: policy({ isEnabled: false }),
        treasurySpendableWei: 1000n,
      }),
    ).toEqual({ kind: 'no-op', reason: 'at-or-above-minimum' });
  });

  it('handles very large values near 2^256 without floating point', () => {
    const minimum = WEI_256 - 100n;
    const target = WEI_256;
    const current = WEI_256 - 200n;
    expect(
      calculateTopUp({
        currentBalanceWei: current,
        policy: policy({
          minimumBalanceWei: minimum,
          targetBalanceWei: target,
          maximumTopUpWei: WEI_256,
        }),
        treasurySpendableWei: WEI_256,
      }),
    ).toEqual({ kind: 'fund', amountWei: 200n });
  });

  it('rejects negative current balance', () => {
    expect(() =>
      calculateTopUp({
        currentBalanceWei: -1n,
        policy: policy(),
        treasurySpendableWei: 1n,
      }),
    ).toThrow(ChainBankError);
  });

  it('rejects negative treasury spendable', () => {
    expect(() =>
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy(),
        treasurySpendableWei: -1n,
      }),
    ).toThrow(ChainBankError);
  });

  it('rejects negative policy amount fields', () => {
    expect(() =>
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({ minimumBalanceWei: -1n }),
        treasurySpendableWei: 1n,
      }),
    ).toThrow(ChainBankError);
  });

  it('throws when below minimum but target is below minimum (invariant breach)', () => {
    expect(() =>
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({ minimumBalanceWei: 100n, targetBalanceWei: 50n, maximumTopUpWei: 10n }),
        treasurySpendableWei: 1000n,
      }),
    ).toThrow(ChainBankError);
  });

  it('applies clamps in order: deficit, then max top-up, then spendable', () => {
    // deficit = 200, max = 120, spendable = 90 → 90
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({
          minimumBalanceWei: 50n,
          targetBalanceWei: 200n,
          maximumTopUpWei: 120n,
        }),
        treasurySpendableWei: 90n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 90n });

    // deficit = 200, max = 80, spendable = 90 → 80
    expect(
      calculateTopUp({
        currentBalanceWei: 0n,
        policy: policy({
          minimumBalanceWei: 50n,
          targetBalanceWei: 200n,
          maximumTopUpWei: 80n,
        }),
        treasurySpendableWei: 90n,
      }),
    ).toEqual({ kind: 'fund', amountWei: 80n });
  });
});
