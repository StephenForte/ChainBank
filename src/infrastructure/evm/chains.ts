import { baseSepolia, sepolia } from 'viem/chains';
import type { Chain } from 'viem';
import { ChainBankError } from '../../domain/errors.js';

/**
 * Explicit chain definitions, keyed by chain ID.
 *
 * Resolution is a lookup rather than a dynamic import so that an unsupported
 * chain ID fails at startup instead of at signing time, and so no mainnet
 * definition is reachable from configuration.
 *
 * The Base entry is viem's `baseSepolia`. Keying the map by that object's id
 * after checking it is 84532 means a viem upgrade that repoints the export
 * fails here, at import, rather than signing against a different network.
 */
const BASE_SEPOLIA_CHAIN_ID = 84532;

if (baseSepolia.id !== BASE_SEPOLIA_CHAIN_ID) {
  throw new ChainBankError(
    'INVALID_CONFIGURATION',
    `viem baseSepolia.id is ${String(baseSepolia.id)}, expected ${String(BASE_SEPOLIA_CHAIN_ID)}`,
    { publicMessage: 'The service is misconfigured.' },
  );
}

const VIEM_CHAINS_BY_ID: ReadonlyMap<number, Chain> = new Map<number, Chain>([
  [sepolia.id, sepolia],
  [BASE_SEPOLIA_CHAIN_ID, baseSepolia],
]);

export function resolveViemChain(chainId: number): Chain {
  const chain = VIEM_CHAINS_BY_ID.get(chainId);
  if (chain === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `No explicit chain definition exists for chain ID ${String(chainId)}`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }
  return chain;
}
