import { HttpRequestError, RpcRequestError, TimeoutError, custom, type Transport } from 'viem';
import { describe, expect, it } from 'vitest';
import { createTreasuryOutgoingScanner } from '../../../src/infrastructure/evm/treasury-outgoing-scanner.js';
import { createLogger } from '../../../src/observability/logger.js';

const SEPOLIA_CHAIN_ID = 11_155_111;
const TREASURY = '0x1111111111111111111111111111111111111111';
const RPC_URL = 'https://rpc.example.test/sepolia';

function chainConfig() {
  return {
    slug: 'ethereum-sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    displayName: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: RPC_URL,
    explorerBaseUrl: 'https://sepolia.etherscan.io',
  };
}

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

function silentLogger() {
  return createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' });
}

interface RecordedRequest {
  readonly method: string;
  readonly atMs: number;
}

/**
 * `retryCount` is the transport config, the second argument. Putting it on
 * the provider object is ignored by viem and leaves the client default.
 */
function scriptedTransport(input: {
  readonly nowMs: () => number;
  readonly requests: RecordedRequest[];
  readonly onBlock: (attempt: number, atMs: number) => void;
}): Transport {
  let blockAttempts = 0;
  return custom(
    {
      request({ method }) {
        const atMs = input.nowMs();
        input.requests.push({ method: String(method), atMs });
        if (method === 'eth_chainId') {
          return Promise.resolve(`0x${SEPOLIA_CHAIN_ID.toString(16)}`);
        }
        if (method === 'eth_blockNumber') {
          return Promise.resolve('0x10');
        }
        if (method === 'eth_getTransactionCount') {
          return Promise.resolve('0x1');
        }
        if (method === 'eth_getBlockByNumber') {
          blockAttempts += 1;
          input.onBlock(blockAttempts, atMs);
          return Promise.resolve({
            number: '0x1',
            hash: `0x${'ab'.repeat(32)}`,
            timestamp: '0x1',
            transactions: [],
          });
        }
        return Promise.reject(new Error(`Unhandled RPC method in test transport: ${String(method)}`));
      },
    },
    { retryCount: 0 },
  );
}

function httpStatus(status: number): HttpRequestError {
  return new HttpRequestError({
    url: RPC_URL,
    status,
    details: 'status',
  });
}

function rpcCode(code: number): RpcRequestError {
  return new RpcRequestError({
    body: { method: 'eth_getBlockByNumber' },
    error: { code, message: 'rpc' },
    url: RPC_URL,
  });
}

function scanOneBlock(input: {
  readonly clock: ReturnType<typeof manualClock>;
  readonly onBlock: (attempt: number, atMs: number) => void;
  readonly maxRequestsPerSecond?: number;
}): {
  readonly scanner: ReturnType<typeof createTreasuryOutgoingScanner>;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const scanner = createTreasuryOutgoingScanner({
    chain: chainConfig(),
    logger: silentLogger(),
    transport: scriptedTransport({ nowMs: input.clock.nowMs, requests, onBlock: input.onBlock }),
    maxRequestsPerSecond: input.maxRequestsPerSecond ?? 25,
    nowMs: input.clock.nowMs,
    sleep: input.clock.sleep,
  });
  return { scanner, requests };
}

function blockReads(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method === 'eth_getBlockByNumber');
}

describe('outgoing scan retry ownership', () => {
  it('keeps retrying a per-minute rejection for 61 s of fake time, then completes', async () => {
    const clock = manualClock();
    const { scanner, requests } = scanOneBlock({
      clock,
      onBlock: (_attempt, atMs) => {
        if (atMs < 61_000) {
          throw rpcCode(-32_008);
        }
      },
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 1n,
    });

    expect(result.kind).toBe('ok');
    expect(blockReads(requests).length).toBeGreaterThan(1);
    expect(clock.nowMs()).toBeGreaterThanOrEqual(61_000);
    expect(clock.nowMs()).toBeLessThan(75_000);
  });

  it('fails closed when a per-minute rejection outlasts the 75 s window', async () => {
    const clock = manualClock();
    const { scanner, requests } = scanOneBlock({
      clock,
      onBlock: (_attempt, atMs) => {
        if (atMs < 76_000) {
          throw rpcCode(-32_008);
        }
      },
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 1n,
    });

    expect(result).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
    const reads = blockReads(requests);
    expect(reads.length).toBeGreaterThan(1);
    for (const read of reads) {
      expect(read.atMs).toBeLessThan(75_000);
    }
    expect(clock.nowMs()).toBeLessThan(76_000);
  });

  it('completes after one HTTP 502 and fails closed after three', async () => {
    const once = manualClock();
    const onceScan = scanOneBlock({
      clock: once,
      onBlock: (attempt) => {
        if (attempt === 1) {
          throw httpStatus(502);
        }
      },
    });
    const onceResult = await onceScan.scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 1n,
    });
    expect(onceResult.kind).toBe('ok');
    expect(blockReads(onceScan.requests)).toHaveLength(2);
    expect(once.nowMs()).toBeLessThanOrEqual(2_000);

    const exhausted = manualClock();
    const exhaustedScan = scanOneBlock({
      clock: exhausted,
      onBlock: () => {
        throw httpStatus(502);
      },
    });
    const exhaustedResult = await exhaustedScan.scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 1n,
    });
    expect(exhaustedResult).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
    expect(blockReads(exhaustedScan.requests)).toHaveLength(3);
    expect(exhausted.nowMs()).toBeLessThanOrEqual(2_000);
  });

  it('does not re-send a non-retriable error', async () => {
    const cases: Array<{ readonly name: string; readonly error: Error }> = [
      { name: '-32000', error: rpcCode(-32_000) },
      { name: 'plain Error', error: new Error('simulated RPC failure') },
      { name: 'HTTP 403', error: httpStatus(403) },
    ];

    for (const testCase of cases) {
      const clock = manualClock();
      const { scanner, requests } = scanOneBlock({
        clock,
        onBlock: () => {
          throw testCase.error;
        },
      });
      const result = await scanner.listOutgoingTransfers({
        fromAddress: TREASURY,
        fromBlock: 5n,
        toBlock: 5n,
      });
      expect(result, testCase.name).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
      expect(blockReads(requests), testCase.name).toHaveLength(1);
      expect(clock.nowMs(), testCase.name).toBe(0);
    }
  });

  it('retries a provider JSON-RPC -1 and a timeout once, and not a synthetic plain Error', async () => {
    const unknown = manualClock();
    const unknownScan = scanOneBlock({
      clock: unknown,
      onBlock: (attempt) => {
        if (attempt === 1) {
          throw rpcCode(-1);
        }
      },
    });
    expect(
      (
        await unknownScan.scanner.listOutgoingTransfers({
          fromAddress: TREASURY,
          fromBlock: 1n,
          toBlock: 1n,
        })
      ).kind,
    ).toBe('ok');
    expect(blockReads(unknownScan.requests)).toHaveLength(2);

    const timedOut = manualClock();
    const timedOutScan = scanOneBlock({
      clock: timedOut,
      onBlock: (attempt) => {
        if (attempt === 1) {
          throw new TimeoutError({ body: {}, url: RPC_URL });
        }
      },
    });
    expect(
      (
        await timedOutScan.scanner.listOutgoingTransfers({
          fromAddress: TREASURY,
          fromBlock: 1n,
          toBlock: 1n,
        })
      ).kind,
    ).toBe('ok');
    expect(blockReads(timedOutScan.requests)).toHaveLength(2);

    const reset: NodeJS.ErrnoException = new Error('socket hang up');
    reset.code = 'ECONNRESET';
    const resetClock = manualClock();
    const resetScan = scanOneBlock({
      clock: resetClock,
      onBlock: (attempt) => {
        if (attempt === 1) {
          throw reset;
        }
      },
    });
    expect(
      (
        await resetScan.scanner.listOutgoingTransfers({
          fromAddress: TREASURY,
          fromBlock: 1n,
          toBlock: 1n,
        })
      ).kind,
    ).toBe('ok');
    expect(blockReads(resetScan.requests)).toHaveLength(2);
  });

  it('paces tip and count reads on the same bucket', async () => {
    const clock = manualClock();
    const requests: RecordedRequest[] = [];
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: silentLogger(),
      transport: scriptedTransport({
        nowMs: clock.nowMs,
        requests,
        onBlock: () => undefined,
      }),
      maxRequestsPerSecond: 2,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    await scanner.getTransactionCountAtBlock({ address: TREASURY, blockNumber: 1n });
    await scanner.getTransactionCountAtBlock({ address: TREASURY, blockNumber: 2n });
    await scanner.getLatestBlockNumber();
    await scanner.getConfirmedTransactionCount(TREASURY);

    expect(clock.nowMs()).toBeGreaterThanOrEqual(1_000);
    expect(maxInAnyOneSecondWindow(requests.map((request) => request.atMs))).toBeLessThanOrEqual(2);
    expect(requests.length).toBeGreaterThanOrEqual(4);
  });

  it('sends a plain Error once when viem retryCount is the transport config', async () => {
    let calls = 0;
    const provider = {
      request() {
        calls += 1;
        return Promise.reject(new Error('plain'));
      },
    };
    const disabled = custom(provider, { retryCount: 0 });
    await expect(disabled({ retryCount: 3 }).request({ method: 'eth_chainId' })).rejects.toThrow();
    expect(disabled({ retryCount: 3 }).config.retryCount).toBe(0);
    expect(calls).toBe(1);

    calls = 0;
    const misplaced = custom(
      {
        retryCount: 0,
        request() {
          calls += 1;
          return Promise.reject(new Error('plain'));
        },
      },
      { retryDelay: 0 },
    );
    await expect(misplaced({ retryCount: 3 }).request({ method: 'eth_chainId' })).rejects.toThrow();
    expect(misplaced({ retryCount: 3 }).config.retryCount).toBe(3);
    expect(calls).toBeGreaterThan(1);
  });
});
