import {
  createPublicClient,
  getAddress,
  http,
  HttpRequestError,
  isAddress,
  RpcRequestError,
  TimeoutError,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import type {
  ConfirmedNonceResult,
  FindByNonceResult,
  LatestBlockNumberResult,
  OutgoingScanResult,
  TreasuryOutgoingScanner,
  TreasuryOutgoingTransfer,
} from '../../app/ports.js';
import type { ChainConfig } from '../../config/index.js';
import {
  DEFAULT_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND,
  DEFAULT_OUTGOING_SCAN_RATE_LIMIT_RETRY_WINDOW_SECONDS,
} from '../../config/schema.js';
import { ChainBankError, describeUnknownError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';
import { resolveViemChain } from './chains.js';

const RPC_TIMEOUT_MS = 10_000;
/**
 * Viem must not retry. A re-send inside the transport takes no token, so
 * under a hard provider cap one paced second can carry `retryCount + 1`
 * times the bucket — at R=25 with viem's 2, the 50 req/s ceiling that
 * stopped the 2026-09-22 Base scan. Every retry decision is
 * {@link withPacedRetry}, after a token.
 */
const TRANSPORT_RETRY_COUNT = 0;
/** Bound concurrent getBlock calls so a large lookback cannot overwhelm the RPC. */
const BLOCK_SCAN_CONCURRENCY = 8;
/** Progress logs for long scans — interval, not per block (TX.9 defect 4). */
const PROGRESS_LOG_INTERVAL_MS = 30_000;
/**
 * Rate-limit backoff: 250 ms doubling, capped at 5 s, until the wall-clock
 * window elapses. A per-minute rejection (-32008) needs that window; a
 * fixed attempt count cannot outlast it. Exhaustion still fails closed.
 */
const RATE_LIMIT_BACKOFF_BASE_MS = 250;
const RATE_LIMIT_BACKOFF_CAP_MS = 5_000;
/**
 * Transient budget. Three attempts and 500 + 1000 = 1500 ms of backoff,
 * under the 2 s ceiling. A provider that is down must become `incomplete`,
 * not stall for the rate-limit window on every block.
 */
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS: readonly number[] = [500, 1_000];
const ONE_SECOND_MS = 1_000;
const CAUSE_WALK_LIMIT = 5;

/**
 * What {@link classifyRpcFailure} matches. The predicate is the class,
 * the numeric JSON-RPC `code`, the HTTP status, or Node's errno `code`.
 * Provider sentences in `details` and `message` are not read.
 *
 * Rate-limit — back off inside
 * `RECONCILE_OUTGOING_SCAN_RATE_LIMIT_RETRY_WINDOW_SECONDS`:
 * - HTTP 429 — `HttpRequestError.status`
 * - JSON-RPC 429 — numeric `code` (HTTP 200 body)
 * - -32005 — EIP-1474 limit exceeded
 * - -32007 — QuickNode per-second limit
 * - -32008 — QuickNode per-minute limit
 * - -32011 — QuickNode method rate limit
 *
 * Transient — the three-attempt budget. This is viem 2.55.8 `shouldRetry`
 * minus the rate-limit codes, and minus the statuses viem retries that are
 * not a blip (HTTP 403, 413, and 504 fail closed):
 * - HTTP 408, 500, 502, 503 — `HttpRequestError.status`
 * - -32603 — JSON-RPC internal error
 * - -1 — JSON-RPC unknown, only on an `RpcRequestError`. viem also assigns
 *   code -1 to `UnknownRpcError` when the thrown value was not an RPC error
 *   (a plain `Error`). That synthetic -1 is not a provider code and does
 *   not retry.
 * - `TimeoutError` — viem's request-timeout class
 * - `code === 'ECONNRESET'` — Node connection reset, including as the
 *   `cause` of an `HttpRequestError` that has no status
 *
 * Anything else, including -32000 and a plain Error, fails closed on the
 * first send.
 */
const RATE_LIMIT_JSON_RPC_CODES: ReadonlySet<number> = new Set([429, -32_005, -32_007, -32_008, -32_011]);
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 500, 502, 503]);
const TRANSIENT_JSON_RPC_INTERNAL_CODE = -32_603;
const JSON_RPC_UNKNOWN_CODE = -1;
const CONNECTION_RESET_CODE = 'ECONNRESET';

export interface CreateTreasuryOutgoingScannerOptions {
  readonly chain: ChainConfig;
  readonly logger: Logger;
  /**
   * Max RPC starts in any one-second window for this scanner instance.
   * Each chain has its own scanner, so the cap is per chain.
   * Defaults to {@link DEFAULT_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND}.
   */
  readonly maxRequestsPerSecond?: number;
  /**
   * How long a rate-limit rejection keeps being retried, in seconds.
   * Defaults to {@link DEFAULT_OUTGOING_SCAN_RATE_LIMIT_RETRY_WINDOW_SECONDS}.
   */
  readonly rateLimitRetryWindowSeconds?: number;
  /** Test-only transport override. */
  readonly transport?: Transport;
  /** Test-only clock for progress-interval assertions and the rate limiter. */
  readonly nowMs?: () => number;
  /**
   * Test-only wait. When `nowMs` is frozen, this must advance that clock;
   * the production timer advances `Date.now`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
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
      retryCount: TRANSPORT_RETRY_COUNT,
    });

  const publicClient: PublicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  const nowMs = options.nowMs ?? (() => Date.now());
  const sleep = options.sleep ?? delay;
  const maxRequestsPerSecond = options.maxRequestsPerSecond ?? DEFAULT_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND;
  if (!Number.isSafeInteger(maxRequestsPerSecond) || maxRequestsPerSecond <= 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Outgoing scan request rate must be a positive integer',
    );
  }
  const acquireRequest = createOutgoingScanTokenBucket({ maxRequestsPerSecond, nowMs, sleep });
  const rateLimitRetryWindowSeconds =
    options.rateLimitRetryWindowSeconds ?? DEFAULT_OUTGOING_SCAN_RATE_LIMIT_RETRY_WINDOW_SECONDS;
  if (!Number.isSafeInteger(rateLimitRetryWindowSeconds) || rateLimitRetryWindowSeconds <= 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Outgoing scan rate-limit retry window must be a positive integer number of seconds',
    );
  }
  const rateLimitRetryWindowMs = rateLimitRetryWindowSeconds * 1_000;
  if (!Number.isSafeInteger(rateLimitRetryWindowMs)) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'Outgoing scan rate-limit retry window is too large');
  }
  const paced = createPacedRpc(publicClient, {
    logger: options.logger,
    sleep,
    acquireRequest,
    nowMs,
    rateLimitRetryWindowMs,
  });

  return {
    async getConfirmedTransactionCount(address: string): Promise<ConfirmedNonceResult> {
      if (!isAddress(address, { strict: false })) {
        throw new ChainBankError('INVALID_ADDRESS', `"${address}" is not a valid EVM address`, {
          publicMessage: 'The supplied address is not a valid EVM address.',
        });
      }

      try {
        const chainCheck = await verifyConfiguredChain(paced, options.chain.chainId);
        if (!chainCheck.ok) {
          return {
            kind: 'unavailable',
            errorCode: chainCheck.errorCode,
            reason: chainCheck.reason,
          };
        }

        const confirmedNonce = await paced.getTransactionCount({
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

    async getLatestBlockNumber(): Promise<LatestBlockNumberResult> {
      try {
        const chainCheck = await verifyConfiguredChain(paced, options.chain.chainId);
        if (!chainCheck.ok) {
          return {
            kind: 'unavailable',
            errorCode: chainCheck.errorCode,
            reason: chainCheck.reason,
          };
        }
        const blockNumber = await paced.getBlockNumber();
        return { kind: 'ok', blockNumber };
      } catch (error) {
        options.logger.error({ detail: describeUnknownError(error) }, 'Failed to read latest block number');
        return {
          kind: 'unavailable',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'Latest block number could not be read from the RPC endpoint.',
        };
      }
    },

    async getTransactionCountAtBlock(input: {
      readonly address: string;
      readonly blockNumber: bigint;
    }): Promise<ConfirmedNonceResult> {
      if (!isAddress(input.address, { strict: false })) {
        throw new ChainBankError('INVALID_ADDRESS', `"${input.address}" is not a valid EVM address`, {
          publicMessage: 'The supplied address is not a valid EVM address.',
        });
      }
      if (input.blockNumber < 0n) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Block number must be non-negative');
      }

      try {
        const chainCheck = await verifyConfiguredChain(paced, options.chain.chainId);
        if (!chainCheck.ok) {
          return {
            kind: 'unavailable',
            errorCode: chainCheck.errorCode,
            reason: chainCheck.reason,
          };
        }

        const confirmedNonce = await paced.getTransactionCount({
          address: getAddress(input.address),
          blockNumber: input.blockNumber,
        });
        return { kind: 'ok', confirmedNonce };
      } catch (error) {
        options.logger.error(
          {
            detail: describeUnknownError(error),
            address: input.address,
            blockNumber: input.blockNumber.toString(),
          },
          'Failed to read transaction count at block',
        );
        return {
          kind: 'unavailable',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'Transaction count at block could not be read from the RPC endpoint.',
        };
      }
    },

    async findOutgoingByNonce(input: {
      readonly fromAddress: string;
      readonly nonce: number;
      readonly lookbackBlocks: bigint;
    }): Promise<FindByNonceResult> {
      if (input.lookbackBlocks < 0n) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          'Outgoing lookback block count must be non-negative',
        );
      }
      if (!Number.isInteger(input.nonce) || input.nonce < 0) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Nonce must be a non-negative integer');
      }
      if (!isAddress(input.fromAddress, { strict: false })) {
        throw new ChainBankError('INVALID_ADDRESS', `"${input.fromAddress}" is not a valid EVM address`, {
          publicMessage: 'The supplied address is not a valid EVM address.',
        });
      }

      const tipResult = await this.getLatestBlockNumber();
      if (tipResult.kind === 'unavailable') {
        return {
          kind: 'incomplete',
          errorCode: tipResult.errorCode,
          reason: tipResult.reason,
        };
      }

      const tip = tipResult.blockNumber;
      const windowStart = tip > input.lookbackBlocks ? tip - input.lookbackBlocks : 0n;

      // If the nonce was already consumed before the searched window, absence
      // must leave the row pending — never invent a terminal state.
      if (windowStart > 0n) {
        const before = await this.getTransactionCountAtBlock({
          address: input.fromAddress,
          blockNumber: windowStart - 1n,
        });
        if (before.kind === 'unavailable') {
          return {
            kind: 'incomplete',
            errorCode: before.errorCode,
            reason: before.reason,
          };
        }
        if (before.confirmedNonce >= input.nonce + 1) {
          return { kind: 'not_found' };
        }
      }

      const tipCount = await this.getTransactionCountAtBlock({
        address: input.fromAddress,
        blockNumber: tip,
      });
      if (tipCount.kind === 'unavailable') {
        return {
          kind: 'incomplete',
          errorCode: tipCount.errorCode,
          reason: tipCount.reason,
        };
      }
      if (tipCount.confirmedNonce < input.nonce + 1) {
        return { kind: 'not_found' };
      }

      // Bisect for the first block B where count(B) >= nonce + 1 (~log₂ window).
      let low = windowStart;
      let high = tip;
      while (low < high) {
        const mid = low + (high - low) / 2n;
        const atMid = await this.getTransactionCountAtBlock({
          address: input.fromAddress,
          blockNumber: mid,
        });
        if (atMid.kind === 'unavailable') {
          return {
            kind: 'incomplete',
            errorCode: atMid.errorCode,
            reason: atMid.reason,
          };
        }
        if (atMid.confirmedNonce >= input.nonce + 1) {
          high = mid;
        } else {
          low = mid + 1n;
        }
      }

      const foundBlock = low;
      try {
        const block = await paced.getBlock(foundBlock);
        const fromNormalized = input.fromAddress.toLowerCase();
        for (const tx of block.transactions) {
          if (typeof tx === 'string') {
            return {
              kind: 'incomplete',
              errorCode: 'RPC_UNAVAILABLE',
              reason: 'RPC returned transaction hashes without bodies; nonce hunt incomplete.',
            };
          }
          if (tx.from.toLowerCase() !== fromNormalized) {
            continue;
          }
          if (tx.nonce !== input.nonce) {
            continue;
          }
          return {
            kind: 'found',
            transfer: {
              transactionHash: tx.hash,
              fromAddress: getAddress(tx.from),
              toAddress: tx.to === null || tx.to === undefined ? undefined : getAddress(tx.to),
              valueWei: tx.value,
              nonce: tx.nonce,
              blockNumber: block.number,
            },
          };
        }
        return { kind: 'not_found' };
      } catch (error) {
        options.logger.error(
          {
            detail: describeUnknownError(error),
            fromAddress: input.fromAddress,
            nonce: input.nonce,
            blockNumber: foundBlock.toString(),
          },
          'Failed to read block for nonce hunt',
        );
        return {
          kind: 'incomplete',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'Block body for nonce hunt could not be read from the RPC endpoint.',
        };
      }
    },

    async listOutgoingTransfers(input: {
      readonly fromAddress: string;
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
    }): Promise<OutgoingScanResult> {
      return scanOutgoingWindow(paced, options, {
        ...input,
        nowMs,
        maxRequestsPerSecond,
      });
    },
  };
}

async function scanOutgoingWindow(
  paced: PacedRpc,
  options: CreateTreasuryOutgoingScannerOptions,
  input: {
    readonly fromAddress: string;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly nowMs: () => number;
    readonly maxRequestsPerSecond: number;
  },
): Promise<OutgoingScanResult> {
  if (!isAddress(input.fromAddress, { strict: false })) {
    throw new ChainBankError('INVALID_ADDRESS', `"${input.fromAddress}" is not a valid EVM address`, {
      publicMessage: 'The supplied address is not a valid EVM address.',
    });
  }
  if (input.fromBlock < 0n || input.toBlock < 0n) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'Outgoing scan block range must be non-negative');
  }
  if (input.fromBlock > input.toBlock) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Outgoing scan fromBlock must be less than or equal to toBlock',
    );
  }

  const fromNormalized = input.fromAddress.toLowerCase();
  const totalBlocks = input.toBlock - input.fromBlock + 1n;
  const startedAtMs = input.nowMs();
  let lastProgressLogAtMs = startedAtMs;
  let blocksScanned = 0n;

  try {
    const chainCheck = await verifyConfiguredChain(paced, options.chain.chainId);
    if (!chainCheck.ok) {
      return {
        kind: 'incomplete',
        errorCode: chainCheck.errorCode,
        reason: chainCheck.reason,
      };
    }

    const transfers: TreasuryOutgoingTransfer[] = [];

    options.logger.info(
      {
        event: 'reconciliation.outgoing_scan.started',
        fromAddress: fromNormalized,
        fromBlock: input.fromBlock.toString(),
        toBlock: input.toBlock.toString(),
        totalBlocks: totalBlocks.toString(),
        maxRequestsPerSecond: input.maxRequestsPerSecond,
      },
      'Treasury outgoing scan started',
    );

    for (
      let windowStart = input.fromBlock;
      windowStart <= input.toBlock;
      windowStart += BigInt(BLOCK_SCAN_CONCURRENCY)
    ) {
      const windowEnd =
        windowStart + BigInt(BLOCK_SCAN_CONCURRENCY) - 1n > input.toBlock
          ? input.toBlock
          : windowStart + BigInt(BLOCK_SCAN_CONCURRENCY) - 1n;

      const blockNumbers: bigint[] = [];
      for (let n = windowStart; n <= windowEnd; n += 1n) {
        blockNumbers.push(n);
      }

      // Concurrency bounds outstanding calls. The token bucket bounds how
      // many of those calls may start in any one-second window.
      const blocks = await Promise.all(blockNumbers.map((blockNumber) => paced.getBlock(blockNumber)));

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

      blocksScanned += BigInt(blockNumbers.length);
      const now = input.nowMs();
      if (now - lastProgressLogAtMs >= PROGRESS_LOG_INTERVAL_MS) {
        const remaining = totalBlocks - blocksScanned;
        options.logger.info(
          {
            event: 'reconciliation.outgoing_scan.progress',
            fromAddress: fromNormalized,
            blocksScanned: blocksScanned.toString(),
            blocksRemaining: remaining.toString(),
            totalBlocks: totalBlocks.toString(),
            fromBlock: input.fromBlock.toString(),
            toBlock: input.toBlock.toString(),
            elapsedMs: now - startedAtMs,
          },
          'Treasury outgoing scan progress',
        );
        lastProgressLogAtMs = now;
      }
    }

    options.logger.info(
      {
        event: 'reconciliation.outgoing_scan.completed',
        fromAddress: fromNormalized,
        blocksScanned: blocksScanned.toString(),
        transferCount: transfers.length,
        fromBlock: input.fromBlock.toString(),
        toBlock: input.toBlock.toString(),
        elapsedMs: input.nowMs() - startedAtMs,
      },
      'Treasury outgoing scan completed',
    );

    return {
      kind: 'ok',
      transfers,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    };
  } catch (error) {
    options.logger.error(
      {
        detail: describeUnknownError(error),
        fromAddress: fromNormalized,
        fromBlock: input.fromBlock.toString(),
        toBlock: input.toBlock.toString(),
        blocksScanned: blocksScanned.toString(),
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
  paced: PacedRpc,
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
    const observedChainId = await paced.getChainId();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Token bucket for scan issuance. Capacity is R. A token is returned only
 * once the request that took it is more than one second old, so any
 * one-second window holds at most R starts. A bucket that refills
 * continuously while still holding a full burst would admit almost 2R in
 * that window, which is over a hard provider ceiling.
 *
 * One bucket per scanner instance. Chains do not share it.
 */
function createOutgoingScanTokenBucket(input: {
  readonly maxRequestsPerSecond: number;
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}): () => Promise<void> {
  const issuedAtMs: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  return function acquire() {
    const turn = queue.then(async () => {
      for (;;) {
        const now = input.nowMs();
        while (issuedAtMs.length > 0) {
          const oldest = issuedAtMs[0];
          if (oldest === undefined || now - oldest <= ONE_SECOND_MS) {
            break;
          }
          issuedAtMs.shift();
        }
        if (issuedAtMs.length < input.maxRequestsPerSecond) {
          issuedAtMs.push(now);
          return;
        }
        const oldest = issuedAtMs[0];
        if (oldest === undefined) {
          issuedAtMs.push(now);
          return;
        }
        const waitMs = Math.max(1, oldest + ONE_SECOND_MS - now + 1);
        await input.sleep(waitMs);
      }
    });
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  };
}

interface PacedRetryContext {
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly acquireRequest: () => Promise<void>;
  readonly nowMs: () => number;
  readonly rateLimitRetryWindowMs: number;
}

/**
 * The only place this file calls `publicClient`. Grep for `publicClient.`
 * should find these four lines and nothing else.
 */
function createPacedRpc(publicClient: PublicClient, retry: PacedRetryContext) {
  return {
    getChainId: () => withPacedRetry(retry, () => publicClient.getChainId()),
    getBlockNumber: () => withPacedRetry(retry, () => publicClient.getBlockNumber()),
    getTransactionCount: (args: Parameters<PublicClient['getTransactionCount']>[0]) =>
      withPacedRetry(retry, () => publicClient.getTransactionCount(args)),
    getBlock: (blockNumber: bigint) =>
      withPacedRetry(retry, () => publicClient.getBlock({ blockNumber, includeTransactions: true }), {
        blockNumber: blockNumber.toString(),
      }),
  };
}

type PacedRpc = ReturnType<typeof createPacedRpc>;

/**
 * Take a token, send once, classify the failure. A retry is another trip
 * through this loop, so it takes its own token. Rate-limit and transient
 * budgets are separate: a 502 never spends the per-minute window.
 */
async function withPacedRetry<T>(
  retry: PacedRetryContext,
  operation: () => Promise<T>,
  logFields?: { readonly blockNumber: string },
): Promise<T> {
  let rateLimitStartedAtMs: number | undefined;
  let rateLimitFailures = 0;
  let transientFailures = 0;

  for (;;) {
    await retry.acquireRequest();
    try {
      return await operation();
    } catch (error) {
      const failureClass = classifyRpcFailure(error);
      if (failureClass === 'rate-limit') {
        const now = retry.nowMs();
        if (rateLimitStartedAtMs === undefined) {
          rateLimitStartedAtMs = now;
        }
        const elapsedMs = now - rateLimitStartedAtMs;
        rateLimitFailures += 1;
        const backoffMs = rateLimitBackoffMs(rateLimitFailures);
        const windowMs = retry.rateLimitRetryWindowMs;
        if (elapsedMs >= windowMs || elapsedMs + backoffMs > windowMs) {
          throw error;
        }
        retry.logger.warn(
          {
            event: 'reconciliation.outgoing_scan.rate_limited',
            ...logFields,
            attempt: rateLimitFailures,
            backoffMs,
            elapsedMs,
          },
          'Treasury outgoing scan hit the provider rate limit; retrying',
        );
        await retry.sleep(backoffMs);
        continue;
      }
      if (failureClass === 'transient') {
        transientFailures += 1;
        if (transientFailures >= TRANSIENT_MAX_ATTEMPTS) {
          throw error;
        }
        const backoffMs = transientBackoffMs(transientFailures);
        retry.logger.warn(
          {
            event: 'reconciliation.outgoing_scan.transient_retry',
            ...logFields,
            attempt: transientFailures,
            backoffMs,
          },
          'Treasury outgoing scan hit a transient RPC error; retrying',
        );
        await retry.sleep(backoffMs);
        continue;
      }
      throw error;
    }
  }
}

function transientBackoffMs(failuresSoFar: number): number {
  const scheduled = TRANSIENT_BACKOFF_MS[failuresSoFar - 1];
  if (scheduled === undefined) {
    return TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1] ?? 1_000;
  }
  return scheduled;
}

function rateLimitBackoffMs(failuresSoFar: number): number {
  const shift = failuresSoFar - 1;
  // 250 * 2^5 = 8000, already past the cap. Avoid a huge intermediate.
  if (shift >= 5) {
    return RATE_LIMIT_BACKOFF_CAP_MS;
  }
  return Math.min(RATE_LIMIT_BACKOFF_CAP_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2 ** shift);
}

type RpcFailureClass = 'rate-limit' | 'transient';

/**
 * First matching node in the cause chain wins. Rate-limit is tested before
 * transient so HTTP 429 is not treated as a short blip.
 */
function classifyRpcFailure(error: unknown): RpcFailureClass | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_WALK_LIMIT && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') {
      return undefined;
    }
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    if (isRateLimitNode(current)) {
      return 'rate-limit';
    }
    if (isTransientNode(current)) {
      return 'transient';
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function isRateLimitNode(error: object): boolean {
  if (error instanceof HttpRequestError && error.status === 429) {
    return true;
  }
  const code = numericCode(error);
  return code !== undefined && RATE_LIMIT_JSON_RPC_CODES.has(code);
}

function isTransientNode(error: object): boolean {
  if (
    error instanceof HttpRequestError &&
    typeof error.status === 'number' &&
    TRANSIENT_HTTP_STATUSES.has(error.status)
  ) {
    return true;
  }
  if (error instanceof TimeoutError) {
    return true;
  }
  if ('code' in error && error.code === CONNECTION_RESET_CODE) {
    return true;
  }
  if (numericCode(error) === TRANSIENT_JSON_RPC_INTERNAL_CODE) {
    return true;
  }
  // Provider-sent -1 only. A synthetic UnknownRpcError(-1) wrapping a plain
  // Error fails this check because it is not an RpcRequestError.
  return error instanceof RpcRequestError && error.code === JSON_RPC_UNKNOWN_CODE;
}

function numericCode(error: object): number | undefined {
  if ('code' in error && typeof error.code === 'number') {
    return error.code;
  }
  return undefined;
}
