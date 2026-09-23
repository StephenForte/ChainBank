import { Writable } from 'node:stream';
import { HttpRequestError, RpcRequestError, custom, type Transport } from 'viem';
import { describe, expect, it } from 'vitest';
import { createTreasuryOutgoingScanner } from '../../../src/infrastructure/evm/treasury-outgoing-scanner.js';
import { createLogger } from '../../../src/observability/logger.js';

const SEPOLIA_CHAIN_ID = 11_155_111;
const TREASURY = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function chainConfig() {
  return {
    slug: 'ethereum-sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    displayName: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: 'https://rpc.example.test/sepolia',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
  };
}

/**
 * Clock the limiter and the transport share. `sleep` yields once so requests
 * already admitted can enter the transport before the clock jumps.
 */
function manualClock(): {
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
} {
  let now = 0;
  return {
    nowMs: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        setImmediate(() => {
          now += ms;
          resolve();
        });
      }),
  };
}

function maxInAnyOneSecondWindow(stamps: readonly number[]): number {
  const sorted = [...stamps].sort((left, right) => left - right);
  let max = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    const atEnd = sorted[end];
    if (atEnd === undefined) {
      continue;
    }
    while (start < end) {
      const atStart = sorted[start];
      if (atStart === undefined || atEnd - atStart <= 1_000) {
        break;
      }
      start += 1;
    }
    max = Math.max(max, end - start + 1);
  }
  return max;
}

function collectLogs(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface RecordedRequest {
  readonly method: string;
  readonly blockNumber: bigint | undefined;
  readonly atMs: number;
}

function scanningTransport(input: {
  readonly nowMs: () => number;
  readonly requests: RecordedRequest[];
  readonly onBlock?: (blockNumber: bigint, attempt: number) => void;
  readonly blockBody?: (blockNumber: bigint) => readonly unknown[];
}): Transport {
  const attempts = new Map<bigint, number>();
  return custom(
    {
      request({ method, params }) {
        if (typeof method !== 'string') {
          return Promise.reject(new Error('RPC method was not a string'));
        }
        if (method === 'eth_chainId') {
          input.requests.push({ method, blockNumber: undefined, atMs: input.nowMs() });
          return Promise.resolve(`0x${SEPOLIA_CHAIN_ID.toString(16)}`);
        }
        if (method === 'eth_getBlockByNumber') {
          const rawParams: unknown = params;
          const blockTag =
            Array.isArray(rawParams) && typeof rawParams[0] === 'string' ? rawParams[0] : undefined;
          if (blockTag === undefined) {
            return Promise.reject(new Error('eth_getBlockByNumber is missing a block number'));
          }
          const blockNumber = BigInt(blockTag);
          const attempt = (attempts.get(blockNumber) ?? 0) + 1;
          attempts.set(blockNumber, attempt);
          input.requests.push({ method, blockNumber, atMs: input.nowMs() });
          input.onBlock?.(blockNumber, attempt);
          const txs = input.blockBody?.(blockNumber) ?? [];
          return Promise.resolve({
            number: `0x${blockNumber.toString(16)}`,
            hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
            timestamp: '0x1',
            transactions: txs,
          });
        }
        return Promise.reject(new Error(`Unhandled RPC method in test transport: ${method}`));
      },
    },
    { retryCount: 0 },
  );
}

function rateLimitError(kind: 'per-second' | 'json-rpc-429' | 'limit-exceeded' | 'http-429'): Error {
  if (kind === 'http-429') {
    return new HttpRequestError({
      url: 'https://rpc.example.test/sepolia',
      status: 429,
      details: 'too many requests',
    });
  }
  const code = kind === 'per-second' ? -32_007 : kind === 'json-rpc-429' ? 429 : -32_005;
  return new RpcRequestError({
    body: { method: 'eth_getBlockByNumber' },
    error: { code, message: 'per-second request limit reached' },
    url: 'https://rpc.example.test/sepolia',
  });
}

describe('treasury outgoing scan request rate', () => {
  it('builds the scanning transport with viem retries disabled', () => {
    const transport = scanningTransport({ nowMs: () => 0, requests: [] });
    expect(transport({ retryCount: 3 }).config.retryCount).toBe(0);
  });

  it('stays at or under R when 30% of blocks are rate-limited once', async () => {
    const maxRequestsPerSecond = 5;
    const fromBlock = 1n;
    const toBlock = 100n;
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({
        nowMs: clock.nowMs,
        requests,
        onBlock: (blockNumber, attempt) => {
          // First read of 3 in every 10 blocks. The retry is a new send and
          // must take its own token.
          if (attempt === 1 && blockNumber % 10n < 3n) {
            throw rateLimitError('per-second');
          }
        },
      }),
      maxRequestsPerSecond,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock,
      toBlock,
    });

    expect(result.kind).toBe('ok');
    const blockRequests = requests.filter((request) => request.method === 'eth_getBlockByNumber');
    const counts = new Map<bigint, number>();
    for (const request of blockRequests) {
      if (request.blockNumber === undefined) {
        continue;
      }
      counts.set(request.blockNumber, (counts.get(request.blockNumber) ?? 0) + 1);
    }
    const expected: bigint[] = [];
    for (let block = fromBlock; block <= toBlock; block += 1n) {
      expected.push(block);
    }
    expect([...counts.keys()].sort((left, right) => (left < right ? -1 : 1))).toEqual(expected);
    for (const [block, count] of counts) {
      if (block % 10n < 3n) {
        expect(count).toBeGreaterThanOrEqual(2);
      } else {
        expect(count).toBe(1);
      }
    }
    expect(maxInAnyOneSecondWindow(requests.map((request) => request.atMs))).toBeLessThanOrEqual(
      maxRequestsPerSecond,
    );
  });

  it('never issues more than R requests in any one-second window', async () => {
    const maxRequestsPerSecond = 5;
    const fromBlock = 1n;
    const toBlock = 200n;
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const sink = collectLogs();
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({
        level: 'info',
        serviceRole: 'test',
        environment: 'test',
        destination: sink.stream,
      }),
      transport: scanningTransport({ nowMs: clock.nowMs, requests }),
      maxRequestsPerSecond,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock,
      toBlock,
    });

    expect(result.kind).toBe('ok');
    const blockRequests = requests.filter((request) => request.method === 'eth_getBlockByNumber');
    expect(blockRequests).toHaveLength(200);
    const peak = maxInAnyOneSecondWindow(requests.map((request) => request.atMs));
    expect(peak).toBe(maxRequestsPerSecond);
    const progress = sink.lines().filter((line) => line.event === 'reconciliation.outgoing_scan.progress');
    expect(progress.length).toBeGreaterThan(0);
  });

  it('fetches every block in the window once and returns the transfer', async () => {
    const fromBlock = 10n;
    const toBlock = 209n;
    const transferBlock = 150n;
    const hash = `0x${'ab'.repeat(32)}`;
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({
        nowMs: clock.nowMs,
        requests,
        blockBody: (blockNumber) =>
          blockNumber === transferBlock
            ? [
                {
                  hash,
                  from: TREASURY,
                  to: OTHER,
                  value: '0x1',
                  nonce: '0x4',
                  type: '0x2',
                },
              ]
            : [],
      }),
      maxRequestsPerSecond: 4,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock,
      toBlock,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      return;
    }
    expect(result.transfers).toEqual([
      {
        transactionHash: hash,
        fromAddress: TREASURY,
        toAddress: OTHER,
        valueWei: 1n,
        nonce: 4,
        blockNumber: transferBlock,
      },
    ]);
    const counts = new Map<bigint, number>();
    for (const request of requests) {
      if (request.method !== 'eth_getBlockByNumber' || request.blockNumber === undefined) {
        continue;
      }
      counts.set(request.blockNumber, (counts.get(request.blockNumber) ?? 0) + 1);
    }
    const expected: bigint[] = [];
    for (let block = fromBlock; block <= toBlock; block += 1n) {
      expected.push(block);
    }
    expect([...counts.keys()].sort((left, right) => (left < right ? -1 : 1))).toEqual(expected);
    for (const count of counts.values()) {
      expect(count).toBe(1);
    }
    expect(maxInAnyOneSecondWindow(requests.map((request) => request.atMs))).toBeLessThanOrEqual(4);
  });

  it('retries a provider rate-limit rejection and still reads every block', async () => {
    const fromBlock = 1n;
    const toBlock = 12n;
    const retriedBlock = 5n;
    const shapes = ['per-second', 'json-rpc-429', 'limit-exceeded', 'http-429'] as const;

    for (const shape of shapes) {
      const clock = manualClock();
      const requests: RecordedRequest[] = [];
      const scanner = createTreasuryOutgoingScanner({
        chain: chainConfig(),
        logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
        transport: scanningTransport({
          nowMs: clock.nowMs,
          requests,
          onBlock: (blockNumber, attempt) => {
            if (blockNumber === retriedBlock && attempt === 1) {
              throw rateLimitError(shape);
            }
          },
        }),
        maxRequestsPerSecond: 25,
        nowMs: clock.nowMs,
        sleep: clock.sleep,
      });

      const result = await scanner.listOutgoingTransfers({
        fromAddress: TREASURY,
        fromBlock,
        toBlock,
      });

      expect(result.kind, shape).toBe('ok');
      const forBlock = requests.filter((request) => request.blockNumber === retriedBlock);
      expect(forBlock, shape).toHaveLength(2);
      const others = requests.filter(
        (request) => request.method === 'eth_getBlockByNumber' && request.blockNumber !== retriedBlock,
      );
      expect(others, shape).toHaveLength(11);
      const counts = new Map<bigint, number>();
      for (const request of others) {
        if (request.blockNumber === undefined) {
          continue;
        }
        counts.set(request.blockNumber, (counts.get(request.blockNumber) ?? 0) + 1);
      }
      for (const count of counts.values()) {
        expect(count, shape).toBe(1);
      }
    }
  });

  it('does not retry a non-rate-limit error whose message mentions a limit', async () => {
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({
        nowMs: clock.nowMs,
        requests,
        onBlock: (blockNumber) => {
          if (blockNumber === 2n) {
            throw new RpcRequestError({
              body: { method: 'eth_getBlockByNumber' },
              error: { code: -32_000, message: 'account limited to 50/sec' },
              url: 'https://rpc.example.test/sepolia',
            });
          }
        },
      }),
      maxRequestsPerSecond: 25,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 4n,
    });

    expect(result).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
    const failedBlock = requests.filter((request) => request.blockNumber === 2n);
    expect(failedBlock).toHaveLength(1);
  });

  it('fails closed after a bounded number of rate-limit retries', async () => {
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({
        nowMs: clock.nowMs,
        requests,
        onBlock: () => {
          throw rateLimitError('per-second');
        },
      }),
      maxRequestsPerSecond: 25,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 7n,
      toBlock: 7n,
    });

    expect(result).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
    const attempts = requests.filter((request) => request.blockNumber === 7n);
    // The old 6-attempt / ~7.75 s budget always exhausted a per-minute cap.
    // A perpetual rejection now retries until the 75 s wall clock, then
    // fails closed, and never sends after that window.
    expect(attempts.length).toBeGreaterThan(6);
    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    expect(first?.atMs).toBe(0);
    expect(last?.atMs).toBeGreaterThan(75_000 - 5_000);
    expect(last?.atMs).toBeLessThan(75_000);
    expect(clock.nowMs()).toBeLessThan(75_000);
    for (const attempt of attempts) {
      expect(attempt.atMs).toBeLessThan(75_000);
    }
  });

  it('keeps a separate bucket per scanner instance', async () => {
    const wideClock = manualClock();
    const narrowClock = manualClock();
    const wideRequests: RecordedRequest[] = [];
    const narrowRequests: RecordedRequest[] = [];
    const wide = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({ nowMs: wideClock.nowMs, requests: wideRequests }),
      maxRequestsPerSecond: 50,
      nowMs: wideClock.nowMs,
      sleep: wideClock.sleep,
    });
    const narrow = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: scanningTransport({ nowMs: narrowClock.nowMs, requests: narrowRequests }),
      maxRequestsPerSecond: 2,
      nowMs: narrowClock.nowMs,
      sleep: narrowClock.sleep,
    });

    await Promise.all([
      wide.listOutgoingTransfers({ fromAddress: TREASURY, fromBlock: 1n, toBlock: 30n }),
      narrow.listOutgoingTransfers({ fromAddress: TREASURY, fromBlock: 1n, toBlock: 8n }),
    ]);

    const widePeak = maxInAnyOneSecondWindow(wideRequests.map((request) => request.atMs));
    const narrowPeak = maxInAnyOneSecondWindow(narrowRequests.map((request) => request.atMs));
    expect(widePeak).toBeGreaterThan(2);
    expect(widePeak).toBeLessThanOrEqual(50);
    expect(narrowPeak).toBe(2);
  });
});
