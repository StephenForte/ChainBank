import { describe, expect, it } from 'vitest';
import { base, baseSepolia, sepolia } from 'viem/chains';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { resolveViemChain } from '../../../../src/infrastructure/evm/chains.js';

describe('resolveViemChain', () => {
  it('returns viem baseSepolia for 84532 and refuses Base mainnet', () => {
    const resolved = resolveViemChain(84532);

    expect(resolved.id).toBe(84532);
    expect(resolved).toBe(baseSepolia);
    expect(resolved).not.toBe(base);
    expect(base.id).toBe(8453);
    expect(baseSepolia.id).toBe(84532);
    expect(resolveViemChain(sepolia.id).id).toBe(11155111);

    expect(() => resolveViemChain(8453)).toThrow(ChainBankError);
    expect(() => resolveViemChain(8453)).toThrow(/8453/);
    try {
      resolveViemChain(1);
      expect.fail('expected INVALID_CONFIGURATION');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INVALID_CONFIGURATION');
    }
  });
});
