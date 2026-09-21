import { describe, expect, it, vi } from 'vitest';
import { checkReadiness } from '../../../../src/app/health/check-readiness.js';
import { createTestChainAdapterRegistry, createFakeBalanceReader } from '../../../support/funding-fakes.js';
import { createFixedClock } from '../../../support/clock.js';

const SEPOLIA = 11_155_111;
/** Fixture chain only. Not registered in SUPPORTED_CHAINS. */
const FIXTURE_CHAIN = 84_532;

describe('checkReadiness', () => {
  it('verifies the chain id of every registered chain', async () => {
    const sepolia = createFakeBalanceReader({ chainId: SEPOLIA });
    const fixture = createFakeBalanceReader({ chainId: FIXTURE_CHAIN });
    const verifySepolia = vi.spyOn(sepolia, 'verifyChainId');
    const verifyFixture = vi.spyOn(fixture, 'verifyChainId');
    const chainAdapters = createTestChainAdapterRegistry({
      balanceReader: sepolia,
      extraChains: [{ chainId: FIXTURE_CHAIN, balanceReader: fixture }],
    });

    const result = await checkReadiness({
      serviceHeartbeats: { list: () => Promise.resolve([]), upsert: vi.fn() },
      chainAdapters,
      clock: createFixedClock(new Date('2026-09-21T00:00:00.000Z')),
    });

    expect(verifySepolia).toHaveBeenCalledTimes(1);
    expect(verifyFixture).toHaveBeenCalledTimes(1);
    expect(result.components.find((component) => component.name === 'rpc')?.status).toBe('ok');
  });

  it('keeps the single-chain failure detail when one registered chain mismatches', async () => {
    const sepolia = createFakeBalanceReader({ chainId: SEPOLIA });
    vi.spyOn(sepolia, 'verifyChainId').mockResolvedValue({
      matches: false,
      observedChainId: 1,
    });

    const result = await checkReadiness({
      serviceHeartbeats: { list: () => Promise.resolve([]), upsert: vi.fn() },
      chainAdapters: createTestChainAdapterRegistry({ balanceReader: sepolia }),
      clock: createFixedClock(new Date('2026-09-21T00:00:00.000Z')),
    });

    expect(result.components.find((component) => component.name === 'rpc')).toEqual({
      name: 'rpc',
      status: 'failed',
      detail: 'The RPC endpoint reports chain 1.',
    });
  });
});
