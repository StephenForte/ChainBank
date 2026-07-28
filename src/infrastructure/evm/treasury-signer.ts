import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TreasurySigner } from '../../app/ports.js';
import type { ChainConfig } from '../../config/index.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import { resolveViemChain } from './chains.js';

const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;

export interface CreateTreasurySignerOptions {
  readonly chain: ChainConfig;
  readonly privateKey: `0x${string}`;
  readonly isKillSwitchActive: boolean;
  readonly logger: Logger;
  /** Test-only transport override. Production always uses HTTP to the configured RPC. */
  readonly transport?: Transport;
}

/**
 * Viem wallet-client adapter for {@link TreasurySigner}.
 *
 * The wallet client is constructed lazily on first signing use and nowhere else
 * in the process tree may import createWalletClient / privateKeyToAccount.
 */
export function createTreasurySigner(options: CreateTreasurySignerOptions): TreasurySigner {
  const { chain, privateKey, isKillSwitchActive, logger } = options;
  const viemChain: Chain = resolveViemChain(chain.chainId);
  const transport =
    options.transport ??
    http(chain.rpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    });

  let account: Account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch (error) {
    throw new ChainBankError(
      'SIGNER_UNAVAILABLE',
      'Treasury signing key could not be loaded into a wallet account.',
      {
        publicMessage: 'Treasury signing is unavailable.',
        cause: error,
      },
    );
  }

  const publicClient: PublicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  // Lazily constructed: only sendNativeTransfer needs the wallet client.
  let walletClient: WalletClient<Transport, Chain, Account> | undefined;

  function getWalletClient(): WalletClient<Transport, Chain, Account> {
    if (walletClient === undefined) {
      walletClient = createWalletClient({
        account,
        chain: viemChain,
        transport,
      });
    }
    return walletClient;
  }

  async function verifyChainId(): Promise<{
    matches: boolean;
    observedChainId: number | undefined;
  }> {
    try {
      const observedChainId = await publicClient.getChainId();
      return { matches: observedChainId === chain.chainId, observedChainId };
    } catch (error) {
      logger.error(
        { detail: describeUnknownError(error), configuredChainId: chain.chainId },
        'Failed to read chain ID from RPC endpoint during signing workflow',
      );
      return { matches: false, observedChainId: undefined };
    }
  }

  async function assertChainMatchesBeforeSend(): Promise<void> {
    const { matches, observedChainId } = await verifyChainId();
    if (!matches) {
      throw new ChainBankError(
        'SIGNER_CHAIN_MISMATCH',
        observedChainId === undefined
          ? `Unable to verify RPC chain ID before signing; configured chain is ${String(chain.chainId)}.`
          : `RPC endpoint reports chain ${String(observedChainId)}, expected ${String(chain.chainId)}. Refusing to sign.`,
        {
          publicMessage: 'Treasury signing refused because the RPC chain ID does not match configuration.',
          context: {
            configuredChainId: chain.chainId,
            observedChainId: observedChainId ?? null,
          },
        },
      );
    }
  }

  function assertKillSwitchInactive(): void {
    if (isKillSwitchActive) {
      throw new ChainBankError(
        'FUNDING_DISABLED',
        'FUNDING_KILL_SWITCH is active; refusing to sign or submit transactions.',
        {
          publicMessage: 'Funding is temporarily disabled.',
        },
      );
    }
  }

  return {
    get address(): string {
      return account.address;
    },

    verifyChainId,

    async getTransactionCount(): Promise<number> {
      try {
        const count = await publicClient.getTransactionCount({ address: account.address });
        return count;
      } catch (error) {
        throw new ChainBankError(
          'RPC_UNAVAILABLE',
          'Failed to read treasury transaction count from the RPC endpoint.',
          {
            publicMessage: 'The RPC endpoint did not return a transaction count.',
            cause: error,
          },
        );
      }
    },

    async estimateTransferCostWei(to: string, valueWei: bigint): Promise<bigint> {
      if (valueWei < 0n) {
        throw new ChainBankError(
          'INVALID_AMOUNT',
          'Transfer value must be a non-negative integer wei amount.',
          {
            publicMessage: 'The transfer amount is not valid.',
          },
        );
      }

      try {
        const gas = await publicClient.estimateGas({
          account: account.address,
          to: to as `0x${string}`,
          value: valueWei,
        });
        const gasPrice = await publicClient.getGasPrice();
        return gas * gasPrice;
      } catch (error) {
        if (error instanceof ChainBankError) {
          throw error;
        }
        // Fail closed: never substitute a constant gas cost.
        throw new ChainBankError(
          'GAS_ESTIMATION_FAILED',
          'Gas estimation failed; refusing to proceed without a reliable transfer cost.',
          {
            publicMessage: 'Transfer cost could not be estimated safely.',
            cause: error,
          },
        );
      }
    },

    async sendNativeTransfer(input: {
      readonly to: string;
      readonly valueWei: bigint;
      readonly nonce: number;
    }): Promise<{ readonly transactionHash: string }> {
      assertKillSwitchInactive();

      if (input.valueWei < 0n) {
        throw new ChainBankError(
          'INVALID_AMOUNT',
          'Transfer value must be a non-negative integer wei amount.',
          {
            publicMessage: 'The transfer amount is not valid.',
          },
        );
      }
      if (!Number.isInteger(input.nonce) || input.nonce < 0) {
        throw new ChainBankError('INVALID_REQUEST', 'Transaction nonce must be a non-negative integer.', {
          publicMessage: 'The request was not valid.',
        });
      }

      await assertChainMatchesBeforeSend();

      try {
        const client = getWalletClient();
        const transactionHash = await client.sendTransaction({
          to: input.to as `0x${string}`,
          value: input.valueWei,
          nonce: input.nonce,
          chain: viemChain,
          account,
        });
        return { transactionHash };
      } catch (error) {
        if (error instanceof ChainBankError) {
          throw error;
        }
        throw new ChainBankError(
          'RPC_UNAVAILABLE',
          'Failed to submit the native transfer to the RPC endpoint.',
          {
            publicMessage: 'The transfer could not be submitted.',
            cause: error,
          },
        );
      }
    },
  };
}
