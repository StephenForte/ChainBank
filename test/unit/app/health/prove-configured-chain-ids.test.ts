import { describe, expect, it } from 'vitest';
import type { BalanceReader } from '../../../../src/app/ports.js';
import { proveConfiguredChainIds } from '../../../../src/app/health/prove-configured-chain-ids.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFakeBalanceReader, createTestChainAdapterRegistry } from '../../../support/funding-fakes.js';

const SEPOLIA = 11_155_111;
const BASE_SEPOLIA = 84_532;

function silentLogger() {
  return createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
}

function readerReporting(chainId: number, observedChainId: number | undefined): BalanceReader {
  const reader = createFakeBalanceReader({ chainId });
  reader.verifyChainId = () =>
    Promise.resolve({
      matches: observedChainId === chainId,
      observedChainId,
    });
  return reader;
}

describe('proveConfiguredChainIds', () => {
  it('fails closed with INVALID_CONFIGURATION when a Base registration reports Sepolia', async () => {
    const chainAdapters = createTestChainAdapterRegistry({
      balanceReader: readerReporting(SEPOLIA, SEPOLIA),
      extraChains: [{ chainId: BASE_SEPOLIA, balanceReader: readerReporting(BASE_SEPOLIA, SEPOLIA) }],
    });

    await expect(proveConfiguredChainIds(chainAdapters, silentLogger())).rejects.toBeInstanceOf(
      ChainBankError,
    );
    try {
      await proveConfiguredChainIds(chainAdapters, silentLogger());
      expect.fail('expected INVALID_CONFIGURATION');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      const chainError = error as ChainBankError;
      expect(chainError.code).toBe('INVALID_CONFIGURATION');
      expect(chainError.category).toBe('validation');
      expect(chainError.code).not.toBe('RPC_UNAVAILABLE');
      expect(chainError.category).not.toBe('dependency_unavailable');
      expect(chainError.message).toContain('84532');
      expect(chainError.message).toContain('11155111');
    }
  });

  it('records an unreachable RPC without treating it as a mismatch', async () => {
    const chainAdapters = createTestChainAdapterRegistry({
      balanceReader: readerReporting(SEPOLIA, undefined),
      extraChains: [{ chainId: BASE_SEPOLIA, balanceReader: readerReporting(BASE_SEPOLIA, BASE_SEPOLIA) }],
    });

    const proofs = await proveConfiguredChainIds(chainAdapters, silentLogger());

    expect(proofs).toEqual([
      { kind: 'unreachable', chainId: SEPOLIA },
      { kind: 'matched', chainId: BASE_SEPOLIA, observedChainId: BASE_SEPOLIA },
    ]);
  });

  it('matches every chain whose RPC reports its registered id', async () => {
    const chainAdapters = createTestChainAdapterRegistry({
      balanceReader: readerReporting(SEPOLIA, SEPOLIA),
      extraChains: [{ chainId: BASE_SEPOLIA, balanceReader: readerReporting(BASE_SEPOLIA, BASE_SEPOLIA) }],
    });

    await expect(proveConfiguredChainIds(chainAdapters, silentLogger())).resolves.toEqual([
      { kind: 'matched', chainId: SEPOLIA, observedChainId: SEPOLIA },
      { kind: 'matched', chainId: BASE_SEPOLIA, observedChainId: BASE_SEPOLIA },
    ]);
  });
});
