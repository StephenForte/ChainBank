import { describe, expect, it } from 'vitest';
import { isTreasuryKind, treasuryKindDisplayName } from '../../../../src/domain/treasury/treasury-kind.js';

describe('treasury kinds (D11)', () => {
  it('maps code kinds to dashboard labels without using public in code', () => {
    expect(treasuryKindDisplayName('external')).toBe('Public');
    expect(treasuryKindDisplayName('operational')).toBe('Private');
  });

  it('accepts only the two persisted kinds', () => {
    expect(isTreasuryKind('external')).toBe(true);
    expect(isTreasuryKind('operational')).toBe(true);
    expect(isTreasuryKind('public')).toBe(false);
  });
});
