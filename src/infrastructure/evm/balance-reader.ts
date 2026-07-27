import { createPublicClient, http, isAddress, type PublicClient } from 'viem';
import type { BalanceReader } from '../../app/ports.js';
import type { ChainConfig } from '../../config/index.js';
import type { BalanceReading } from '../../domain/balance-reading.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { resolveViemChain } from './chains.js';

const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;

export interface CreateBalanceReaderOptions {
  readonly chain: ChainConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Read-only chain access built on a Viem public client.
 *
 * There is intentionally no wallet client in this module or anywhere else in
 * the Phase 0 tree. Nothing here can construct, sign, or submit a transaction.
 */
export function createBalanceReader(options: CreateBalanceReaderOptions): BalanceReader {
  const { chain, clock, logger } = options;

  const client: PublicClient = createPublicClient({
    chain: resolveViemChain(chain.chainId),
    transport: http(chain.rpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    }),
  });

  async function verifyChainId(): Promise<{ matches: boolean; observedChainId: number | undefined }> {
    try {
      const observedChainId = await client.getChainId();
      return { matches: observedChainId === chain.chainId, observedChainId };
    } catch (error) {
      logger.error(
        { detail: describeUnknownError(error), configuredChainId: chain.chainId },
        'Failed to read chain ID from RPC endpoint',
      );
      return { matches: false, observedChainId: undefined };
    }
  }

  return {
    verifyChainId,

    async readBalance(address: string): Promise<BalanceReading> {
      if (!isAddress(address, { strict: false })) {
        throw new ChainBankError('INVALID_ADDRESS', `"${address}" is not a valid EVM address`, {
          publicMessage: 'The supplied address is not a valid EVM address.',
        });
      }

      try {
        // Chain identity and block height are fetched together, but the balance
        // is only accepted after the chain ID is confirmed to match. An
        // unverified reading is never returned to a caller.
        const [observedChainId, blockNumber] = await Promise.all([
          client.getChainId(),
          client.getBlockNumber(),
        ]);

        if (observedChainId !== chain.chainId) {
          logger.error(
            { configuredChainId: chain.chainId, observedChainId },
            'Configured chain ID does not match the chain reported by the RPC endpoint',
          );
          return {
            kind: 'unavailable',
            errorCode: 'CHAIN_ID_MISMATCH',
            reason: `RPC endpoint reports chain ${String(observedChainId)}, expected ${String(chain.chainId)}`,
            observedAt: clock.now(),
          };
        }

        // Pinning the balance to the block height just read keeps the pair
        // internally consistent instead of straddling two block boundaries.
        const balanceWei = await client.getBalance({ address, blockNumber });

        return { kind: 'observed', balanceWei, blockNumber, observedAt: clock.now() };
      } catch (error) {
        // A provider failure is a distinct, reportable state. It must never be
        // flattened into a zero balance.
        const detail = describeUnknownError(error);
        logger.error({ detail, chainId: chain.chainId }, 'Balance read failed');
        return {
          kind: 'unavailable',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'The RPC endpoint did not return a balance.',
          observedAt: clock.now(),
        };
      }
    },
  };
}
