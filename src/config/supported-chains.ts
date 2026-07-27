/**
 * Chains ChainBank is permitted to talk to.
 *
 * Mainnets are absent by design, not by omission. Adding one requires an
 * architectural decision record and the Phase 8 production evaluation, so a
 * misconfigured environment variable can never point the service at real value.
 */
export interface SupportedChain {
  readonly slug: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
  readonly defaultExplorerBaseUrl: string;
}

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  {
    slug: 'ethereum-sepolia',
    chainId: 11155111,
    displayName: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    defaultExplorerBaseUrl: 'https://sepolia.etherscan.io',
  },
];

export function findSupportedChainById(chainId: number): SupportedChain | undefined {
  return SUPPORTED_CHAINS.find((chain) => chain.chainId === chainId);
}

export function supportedChainIds(): readonly number[] {
  return SUPPORTED_CHAINS.map((chain) => chain.chainId);
}
