import { describe, expect, it } from 'vitest';
import { formatTestEmailChains } from '../../../src/api/routes/admin.js';
import type { ConfiguredChain } from '../../../src/config/index.js';

const ZERO = 0n;

function chain(input: {
  readonly displayName: string;
  readonly chainId: number;
  readonly treasuryAddress: `0x${string}`;
  readonly operationalAddress?: `0x${string}`;
}): ConfiguredChain {
  const treasury = {
    address: input.treasuryAddress,
    warningBalanceWei: ZERO,
    criticalBalanceWei: ZERO,
    recoveryBalanceWei: ZERO,
    minimumReserveWei: ZERO,
  };
  return {
    slug: 'chain',
    chainId: input.chainId,
    displayName: input.displayName,
    nativeSymbol: 'ETH',
    rpcUrl: 'https://rpc.example.test',
    explorerBaseUrl: 'https://explorer.example.test',
    treasury,
    operationalTreasury:
      input.operationalAddress === undefined
        ? undefined
        : {
            address: input.operationalAddress,
            warningBalanceWei: ZERO,
            criticalBalanceWei: ZERO,
            recoveryBalanceWei: ZERO,
            minimumReserveWei: ZERO,
            policy: {
              minimumBalanceWei: ZERO,
              targetBalanceWei: ZERO,
              maximumTopUpWei: ZERO,
            },
          },
  };
}

const SEPOLIA = '0x1111111111111111111111111111111111111111';
const SEPOLIA_PRIVATE = '0x3333333333333333333333333333333333333333';
const BASE = '0x2222222222222222222222222222222222222222';

describe('formatTestEmailChains', () => {
  it('keeps a single configured chain on the two lines the template already prints', () => {
    const copy = formatTestEmailChains([
      chain({
        displayName: 'Ethereum Sepolia',
        chainId: 11_155_111,
        treasuryAddress: SEPOLIA,
        operationalAddress: SEPOLIA_PRIVATE,
      }),
    ]);
    expect(copy).toEqual({
      chainDisplayName: 'Ethereum Sepolia',
      treasuryAddressDisplay: SEPOLIA,
    });
  });

  it('names every chain and its treasury in one message', () => {
    const copy = formatTestEmailChains([
      chain({
        displayName: 'Ethereum Sepolia',
        chainId: 11_155_111,
        treasuryAddress: SEPOLIA,
        operationalAddress: SEPOLIA_PRIVATE,
      }),
      chain({
        displayName: 'Base Sepolia',
        chainId: 84_532,
        treasuryAddress: BASE,
      }),
    ]);
    expect(copy.chainDisplayName).toBe('Ethereum Sepolia, Base Sepolia');
    expect(copy.treasuryAddressDisplay).toBe(
      `Ethereum Sepolia ${SEPOLIA} / Private ${SEPOLIA_PRIVATE}; Base Sepolia ${BASE}`,
    );
    expect(copy.treasuryAddressDisplay).not.toBe(SEPOLIA);
  });

  it('refuses to invent copy when no chain is configured', () => {
    expect(() => formatTestEmailChains([])).toThrow(/No chain is configured/);
  });
});
