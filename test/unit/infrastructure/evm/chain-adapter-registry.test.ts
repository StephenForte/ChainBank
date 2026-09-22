import { describe, expect, it } from 'vitest';
import type { TreasurySigner } from '../../../../src/app/ports.js';
import { SUPPORTED_CHAINS } from '../../../../src/config/supported-chains.js';
import { createChainAdapterRegistry } from '../../../../src/infrastructure/evm/chain-adapter-registry.js';
import {
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
} from '../../../support/funding-fakes.js';

const SEPOLIA = 11_155_111;
/**
 * Base Sepolia's id. Tests that need a second registry entry register it
 * explicitly. A catalog row does not insert an adapter.
 */
const FIXTURE_CHAIN = 84_532;
const SHARED_ADDRESS = '0x1111111111111111111111111111111111111111';

function registration(chainId: number, signer?: TreasurySigner) {
  return {
    chainId,
    balanceReader: createFakeBalanceReader({ chainId }),
    receiptTracker: createFakeReceiptTracker({ kind: 'pending' }),
    outgoingScanner: createFakeOutgoingScanner(),
    ...(signer === undefined ? {} : { signers: [signer], externalSigner: signer }),
  };
}

describe('createChainAdapterRegistry', () => {
  it('lists Sepolia and Base Sepolia in the production catalog and no mainnet id', () => {
    expect(SUPPORTED_CHAINS.map((chain) => chain.chainId)).toEqual([SEPOLIA, FIXTURE_CHAIN]);
    expect(SUPPORTED_CHAINS.map((chain) => chain.slug)).toEqual(['ethereum-sepolia', 'base-sepolia']);
    for (const mainnetId of [1, 8453, 137, 56]) {
      expect(SUPPORTED_CHAINS.some((chain) => chain.chainId === mainnetId)).toBe(false);
    }
  });

  it('throws INVALID_CONFIGURATION for an unregistered chain and does not return the registered adapters', () => {
    const sepoliaReader = createFakeBalanceReader({ chainId: SEPOLIA });
    const registry = createChainAdapterRegistry([{ ...registration(SEPOLIA), balanceReader: sepoliaReader }]);

    expect(registry.balanceReader(SEPOLIA)).toBe(sepoliaReader);
    expect(() => registry.balanceReader(FIXTURE_CHAIN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() => registry.receiptTracker(FIXTURE_CHAIN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() => registry.outgoingScanner(FIXTURE_CHAIN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() => registry.externalSigner(FIXTURE_CHAIN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(registry.balanceReader(SEPOLIA)).toBe(sepoliaReader);
    expect(sepoliaReader.reads).toEqual([]);
  });

  it('resolves the same address to the signer bound to that treasury row’s chain', () => {
    const sepoliaSigner = createFakeSigner({ address: SHARED_ADDRESS, chainId: SEPOLIA });
    const fixtureSigner = createFakeSigner({ address: SHARED_ADDRESS, chainId: FIXTURE_CHAIN });
    const registry = createChainAdapterRegistry([
      registration(SEPOLIA, sepoliaSigner),
      registration(FIXTURE_CHAIN, fixtureSigner),
    ]);

    const onSepolia = registry.getSignerForTreasury({
      id: 'treasury-sepolia',
      address: SHARED_ADDRESS,
      chain: { chainId: SEPOLIA },
    });
    const onFixture = registry.getSignerForTreasury({
      id: 'treasury-fixture',
      address: SHARED_ADDRESS,
      chain: { chainId: FIXTURE_CHAIN },
    });

    expect(onSepolia).toBe(sepoliaSigner);
    expect(onSepolia.chainId).toBe(SEPOLIA);
    expect(onFixture).toBe(fixtureSigner);
    expect(onFixture.chainId).toBe(FIXTURE_CHAIN);
    expect(onSepolia).not.toBe(onFixture);
  });

  it('throws INVALID_CONFIGURATION when no signer exists for that chain, even if another chain has the address', () => {
    const sepoliaSigner = createFakeSigner({ address: SHARED_ADDRESS, chainId: SEPOLIA });
    const registry = createChainAdapterRegistry([
      registration(SEPOLIA, sepoliaSigner),
      registration(FIXTURE_CHAIN),
    ]);

    expect(() =>
      registry.getSignerForTreasury({
        id: 'treasury-fixture',
        address: SHARED_ADDRESS,
        chain: { chainId: FIXTURE_CHAIN },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(
      registry.getSignerForTreasury({
        id: 'treasury-sepolia',
        address: SHARED_ADDRESS,
        chain: { chainId: SEPOLIA },
      }),
    ).toBe(sepoliaSigner);
  });

  it('throws SIGNER_UNAVAILABLE when the process has no signing credentials', () => {
    const registry = createChainAdapterRegistry([registration(SEPOLIA)]);
    expect(registry.canSign).toBe(false);
    expect(() =>
      registry.getSignerForTreasury({
        id: 'treasury-sepolia',
        address: SHARED_ADDRESS,
        chain: { chainId: SEPOLIA },
      }),
    ).toThrowError(expect.objectContaining({ code: 'SIGNER_UNAVAILABLE' }));
  });
});
