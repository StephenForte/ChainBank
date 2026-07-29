import {
  createPublicClient,
  http,
  type Chain,
  type PublicClient,
  type Transport,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import type { TransactionReceiptTracker, TransactionTrackingOutcome } from '../../app/ports.js';
import type { ChainConfig } from '../../config/index.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { resolveViemChain } from './chains.js';

const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;

export interface CreateTransactionReceiptTrackerOptions {
  readonly chain: ChainConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Test-only transport override. */
  readonly transport?: Transport;
}

/**
 * Public-client receipt waiter. Never constructs a wallet client or holds keys.
 *
 * Outcomes map explicitly to confirmed / reverted / replaced / dropped / pending.
 * Timeout ⇒ pending (D4), never failure.
 */
export function createTransactionReceiptTracker(
  options: CreateTransactionReceiptTrackerOptions,
): TransactionReceiptTracker {
  const viemChain: Chain = resolveViemChain(options.chain.chainId);
  const transport =
    options.transport ??
    http(options.chain.rpcUrl, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: RPC_RETRY_COUNT,
    });

  const publicClient: PublicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  return {
    async waitForOutcome(input: {
      readonly transactionHash: string;
      readonly confirmations: number;
      readonly timeoutMs: number;
    }): Promise<TransactionTrackingOutcome> {
      const hash = input.transactionHash as `0x${string}`;

      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: input.confirmations,
          timeout: input.timeoutMs,
        });

        if (receipt.status === 'success') {
          return { kind: 'confirmed', confirmedAt: options.clock.now() };
        }
        if (receipt.status === 'reverted') {
          return { kind: 'reverted' };
        }
        // Unexpected status string from the driver — fail closed as reverted.
        options.logger.warn(
          { transactionHash: hash, receiptStatus: receipt.status },
          'Unexpected transaction receipt status; treating as reverted',
        );
        return { kind: 'reverted' };
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) {
          return { kind: 'pending' };
        }

        const replacedOrDropped = await classifyMissingTransaction(publicClient, hash, options.logger);
        if (replacedOrDropped !== undefined) {
          return replacedOrDropped;
        }

        throw new ChainBankError(
          'RPC_UNAVAILABLE',
          'Failed while waiting for funding transaction confirmation.',
          {
            publicMessage: 'Transaction confirmation could not be determined.',
            cause: error,
            context: { detail: describeUnknownError(error) },
          },
        );
      }
    },
  };
}

/**
 * When a wait fails for a reason other than timeout, probe whether the tx is
 * gone (dropped) or a different hash mined for the same nonce (replaced).
 */
async function classifyMissingTransaction(
  publicClient: PublicClient,
  hash: `0x${string}`,
  logger: Logger,
): Promise<Extract<TransactionTrackingOutcome, { kind: 'replaced' | 'dropped' }> | undefined> {
  try {
    const tx = await publicClient.getTransaction({ hash });
    if (tx === null) {
      return { kind: 'dropped' };
    }
    // Still in mempool or unknown — let the caller treat as retriable RPC error.
    return undefined;
  } catch (error) {
    // Some nodes throw when the tx is unknown; distinguish replacement when possible.
    try {
      const tx = await publicClient.getTransaction({ hash }).catch(() => null);
      if (tx === null) {
        return { kind: 'dropped' };
      }
    } catch {
      // fall through
    }
    logger.warn(
      { transactionHash: hash, detail: describeUnknownError(error) },
      'Could not classify missing funding transaction',
    );
    return undefined;
  }
}
