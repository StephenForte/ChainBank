import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import type {
  ConfirmedNonceResult,
  FindByNonceResult,
  OutgoingScanResult,
  TreasuryOutgoingScanner,
  TreasuryOutgoingTransfer,
} from '../../app/ports.js';
import type { ChainConfig } from '../../config/index.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import { resolveViemChain } from './chains.js';

const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;
/** Bound concurrent getBlock calls so a large lookback cannot overwhelm the RPC. */
const BLOCK_SCAN_CONCURRENCY = 8;

export interface CreateTreasuryOutgoingScannerOptions {
  readonly chain: ChainConfig;
  readonly logger: Logger;
  /** Test-only transport override. */
  readonly transport?: Transport;
}

/**
 * Public-client scanner for treasury outgoing native transfers (C14).
 *
 * Never constructs a wallet client. Fail closed on RPC errors: an unscannable
 * chain yields `incomplete` / `unavailable`, never a clean empty report.
 */
export function createTreasuryOutgoingScanner(
  options: CreateTreasuryOutgoingScannerOptions,
): TreasuryOutgoingScanner {
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
    async getConfirmedTransactionCount(address: string): Promise<ConfirmedNonceResult> {
      if (!isAddress(address, { strict: false })) {
        throw new ChainBankError('INVALID_ADDRESS', `"${address}" is not a valid EVM address`, {
          publicMessage: 'The supplied address is not a valid EVM address.',
        });
      }

      try {
        const chainCheck = await verifyConfiguredChain(publicClient, options.chain.chainId);
        if (!chainCheck.ok) {
          return {
            kind: 'unavailable',
            errorCode: chainCheck.errorCode,
            reason: chainCheck.reason,
          };
        }

        const confirmedNonce = await publicClient.getTransactionCount({
          address: getAddress(address),
          blockTag: 'latest',
        });
        return { kind: 'ok', confirmedNonce };
      } catch (error) {
        options.logger.error(
          { detail: describeUnknownError(error), address },
          'Failed to read confirmed transaction count',
        );
        return {
          kind: 'unavailable',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'Confirmed transaction count could not be read from the RPC endpoint.',
        };
      }
    },

    async findOutgoingByNonce(input: {
      readonly fromAddress: string;
      readonly nonce: number;
      readonly lookbackBlocks: bigint;
    }): Promise<FindByNonceResult> {
      const scan = await scanOutgoingWindow(publicClient, options, input);
      if (scan.kind === 'incomplete') {
        return scan;
      }

      const match = scan.transfers.find((transfer) => transfer.nonce === input.nonce);
      if (match === undefined) {
        return { kind: 'not_found' };
      }
      return { kind: 'found', transfer: match };
    },

    async listRecentOutgoingTransfers(input: {
      readonly fromAddress: string;
      readonly lookbackBlocks: bigint;
    }): Promise<OutgoingScanResult> {
      return scanOutgoingWindow(publicClient, options, input);
    },
  };
}

async function scanOutgoingWindow(
  publicClient: PublicClient,
  options: CreateTreasuryOutgoingScannerOptions,
  input: { readonly fromAddress: string; readonly lookbackBlocks: bigint },
): Promise<OutgoingScanResult> {
  if (!isAddress(input.fromAddress, { strict: false })) {
    throw new ChainBankError('INVALID_ADDRESS', `"${input.fromAddress}" is not a valid EVM address`, {
      publicMessage: 'The supplied address is not a valid EVM address.',
    });
  }
  if (input.lookbackBlocks < 0n) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'Outgoing lookback block count must be non-negative');
  }

  const fromNormalized = input.fromAddress.toLowerCase();

  try {
    const chainCheck = await verifyConfiguredChain(publicClient, options.chain.chainId);
    if (!chainCheck.ok) {
      return {
        kind: 'incomplete',
        errorCode: chainCheck.errorCode,
        reason: chainCheck.reason,
      };
    }

    const tip = await publicClient.getBlockNumber();
    const fromBlock = tip > input.lookbackBlocks ? tip - input.lookbackBlocks : 0n;
    const transfers: TreasuryOutgoingTransfer[] = [];

    for (let windowStart = fromBlock; windowStart <= tip; windowStart += BigInt(BLOCK_SCAN_CONCURRENCY)) {
      const windowEnd =
        windowStart + BigInt(BLOCK_SCAN_CONCURRENCY) - 1n > tip
          ? tip
          : windowStart + BigInt(BLOCK_SCAN_CONCURRENCY) - 1n;

      const blockNumbers: bigint[] = [];
      for (let n = windowStart; n <= windowEnd; n += 1n) {
        blockNumbers.push(n);
      }

      const blocks = await Promise.all(
        blockNumbers.map((blockNumber) => publicClient.getBlock({ blockNumber, includeTransactions: true })),
      );

      for (const block of blocks) {
        for (const tx of block.transactions) {
          if (typeof tx === 'string') {
            // includeTransactions should expand hashes; fail closed if not.
            return {
              kind: 'incomplete',
              errorCode: 'RPC_UNAVAILABLE',
              reason: 'RPC returned transaction hashes without bodies; outgoing scan incomplete.',
            };
          }
          if (tx.from.toLowerCase() !== fromNormalized) {
            continue;
          }
          // Native value transfers only — contract calls with zero value are
          // ignored for crash-orphan detection of funding sends.
          if (tx.value === 0n) {
            continue;
          }
          transfers.push({
            transactionHash: tx.hash,
            fromAddress: getAddress(tx.from),
            toAddress: tx.to === null || tx.to === undefined ? undefined : getAddress(tx.to),
            valueWei: tx.value,
            nonce: tx.nonce,
            blockNumber: block.number,
          });
        }
      }
    }

    return { kind: 'ok', transfers };
  } catch (error) {
    options.logger.error(
      {
        detail: describeUnknownError(error),
        fromAddress: fromNormalized,
        lookbackBlocks: input.lookbackBlocks.toString(),
      },
      'Treasury outgoing scan failed',
    );
    return {
      kind: 'incomplete',
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'Treasury outgoing transaction scan could not be completed.',
    };
  }
}

async function verifyConfiguredChain(
  publicClient: PublicClient,
  configuredChainId: number,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errorCode: 'CHAIN_ID_MISMATCH' | 'RPC_UNAVAILABLE';
      readonly reason: string;
    }
> {
  try {
    const observedChainId = await publicClient.getChainId();
    if (observedChainId !== configuredChainId) {
      return {
        ok: false,
        errorCode: 'CHAIN_ID_MISMATCH',
        reason: `RPC endpoint reports chain ${String(observedChainId)}, expected ${String(configuredChainId)}`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'Chain ID could not be read from the RPC endpoint.',
    };
  }
}
