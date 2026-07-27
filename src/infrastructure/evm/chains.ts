import { sepolia } from 'viem/chains';
import type { Chain } from 'viem';
import { ChainBankError } from '../../domain/errors.js';

/**
 * Explicit chain definitions, keyed by chain ID.
 *
 * Resolution is a lookup rather than a dynamic import so that an unsupported
 * chain ID fails at startup instead of at signing time, and so no mainnet
 * definition is reachable from configuration.
 */
const VIEM_CHAINS_BY_ID: ReadonlyMap<number, Chain> = new Map<number, Chain>([[sepolia.id, sepolia]]);

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
