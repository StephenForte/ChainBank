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
      readonly senderAddress: string;
      readonly nonce: number;
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

        const classified = await classifyMissingTransaction(publicClient, hash, options.logger, {
          senderAddress: input.senderAddress,
          nonce: input.nonce,
        });
        if (classified !== undefined) {
          return classified;
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
 * When a wait fails for a reason other than timeout, decide whether there is
 * *positive evidence* that the transaction can never mine.
 *
 * The only such evidence available here is a consumed nonce: if the sender's
 * account nonce has advanced past this transaction's nonce while the hash is
 * unknown to the node, some other transaction took that nonce and this one is
 * permanently superseded (`replaced`).
 *
 * Everything else — an unknown hash on a lagging or load-balanced node, a
 * network error during the probe — yields `pending`. A transient failure must
 * never be recorded as a terminal state, because a terminal row reopens the
 * duplicate-funding gate while the transfer may still be in the mempool
 * (AGENTS.md §7.5).
 */
async function classifyMissingTransaction(
  publicClient: PublicClient,
  hash: `0x${string}`,
  logger: Logger,
  sender: { readonly senderAddress: string; readonly nonce: number },
): Promise<Extract<TransactionTrackingOutcome, { kind: 'replaced' | 'pending' }> | undefined> {
  // viem throws TransactionNotFoundError rather than returning null when the
  // node does not know the hash; treat any failure here as "not visible".
  const transaction = await publicClient.getTransaction({ hash }).catch(() => null);
  if (transaction !== null) {
    // Known to the node but the wait failed — retriable, not terminal.
    return undefined;
  }

  let accountNonce: number;
  try {
    accountNonce = await publicClient.getTransactionCount({
      address: sender.senderAddress as `0x${string}`,
      blockTag: 'latest',
    });
  } catch (error) {
    logger.warn(
      { transactionHash: hash, detail: describeUnknownError(error) },
      'Could not probe sender nonce; treating funding transaction as still pending',
    );
    return { kind: 'pending' };
  }

  if (accountNonce > sender.nonce) {
    logger.warn(
      { transactionHash: hash, nonce: sender.nonce, accountNonce },
      'Funding transaction nonce was consumed by another transaction; treating as replaced',
    );
    return { kind: 'replaced' };
  }

  logger.info(
    { transactionHash: hash, nonce: sender.nonce, accountNonce },
    'Funding transaction not yet visible to the node; remaining pending',
  );
  return { kind: 'pending' };
}
