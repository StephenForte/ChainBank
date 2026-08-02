import { Writable } from 'node:stream';
import { custom, type Transport } from 'viem';
import { describe, expect, it } from 'vitest';
import { createTreasuryOutgoingScanner } from '../../../src/infrastructure/evm/treasury-outgoing-scanner.js';
import { createLogger } from '../../../src/observability/logger.js';

const SEPOLIA_CHAIN_ID = 11_155_111;
const TREASURY = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

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

function mockTransport(options: {
  readonly tip: bigint;
  readonly transfersByBlock?: ReadonlyMap<bigint, readonly unknown[]>;
  readonly failAtBlock?: bigint;
  /** Monotonic account nonce as of each block (next nonce / tx count). */
  readonly countAtBlock?: (blockNumber: bigint) => number;
  readonly counters?: { getBlock: number; getTransactionCount: number };
}): Transport {
  const counters = options.counters ?? { getBlock: 0, getTransactionCount: 0 };
  return custom({
    request({ method, params }) {
      switch (method) {
        case 'eth_chainId':
          return Promise.resolve(`0x${SEPOLIA_CHAIN_ID.toString(16)}`);
        case 'eth_blockNumber':
          return Promise.resolve(`0x${options.tip.toString(16)}`);
        case 'eth_getTransactionCount': {
          counters.getTransactionCount += 1;
          const blockTag = (params as [string, string | undefined])[1];
          let blockNumber = options.tip;
          if (typeof blockTag === 'string' && blockTag.startsWith('0x')) {
            blockNumber = BigInt(blockTag);
          }
          const count = options.countAtBlock?.(blockNumber) ?? 0;
          return Promise.resolve(`0x${count.toString(16)}`);
        }
        case 'eth_getBlockByNumber': {
          counters.getBlock += 1;
          const raw = (params as [string, boolean])[0];
          const blockNumber = BigInt(raw);
          if (options.failAtBlock !== undefined && blockNumber === options.failAtBlock) {
            return Promise.reject(new Error('simulated RPC failure'));
          }
          const txs = options.transfersByBlock?.get(blockNumber) ?? [];
          return Promise.resolve({
            number: `0x${blockNumber.toString(16)}`,
            hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
            timestamp: '0x1',
            transactions: txs,
          });
        }
        default:
          return Promise.reject(new Error(`Unhandled RPC method in test transport: ${method}`));
      }
    },
  });
}

describe('createTreasuryOutgoingScanner', () => {
  it('scans an inclusive window and returns only native value transfers from the treasury', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const transport = mockTransport({
      tip: 10n,
      transfersByBlock: new Map([
        [
          5n,
          [
            {
              hash,
              from: TREASURY,
              to: OTHER,
              value: `0x${(10n ** 18n).toString(16)}`,
              nonce: '0x3',
              type: '0x2',
            },
            {
              hash: `0x${'cd'.repeat(32)}`,
              from: TREASURY,
              to: OTHER,
              value: '0x0',
              nonce: '0x4',
              type: '0x2',
            },
            {
              hash: `0x${'ef'.repeat(32)}`,
              from: OTHER,
              to: TREASURY,
              value: `0x${(10n ** 18n).toString(16)}`,
              nonce: '0x1',
              type: '0x2',
            },
          ],
        ],
      ]),
    });

    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport,
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 5n,
      toBlock: 5n,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      return;
    }
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.transactionHash).toBe(hash);
    expect(result.transfers[0]?.nonce).toBe(3);
  });

  it('fails closed to incomplete on RPC error mid-window', async () => {
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: mockTransport({ tip: 20n, failAtBlock: 12n }),
    });

    const result = await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 10n,
      toBlock: 15n,
    });
    expect(result).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
  });

  it('emits periodic progress logs during a long scan', async () => {
    const sink = collectLogs();
    let now = 0;
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({
        level: 'info',
        serviceRole: 'test',
        environment: 'test',
        destination: sink.stream,
      }),
      transport: mockTransport({ tip: 40n }),
      nowMs: () => {
        now += 10_000;
        return now;
      },
    });

    await scanner.listOutgoingTransfers({
      fromAddress: TREASURY,
      fromBlock: 1n,
      toBlock: 40n,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const progress = sink.lines().filter((line) => line.event === 'reconciliation.outgoing_scan.progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.event).toBe('reconciliation.outgoing_scan.progress');
    expect(typeof progress[0]?.blocksScanned).toBe('string');
    expect(typeof progress[0]?.blocksRemaining).toBe('string');
  });

  it('leaves findOutgoingByNonce as not_found when the nonce predates the searched window', async () => {
    // tip 100, lookback 20 ⇒ window [80, 100]. Nonce 7 already consumed by block 79.
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: mockTransport({
        tip: 100n,
        countAtBlock: () => 8,
      }),
    });

    const result = await scanner.findOutgoingByNonce({
      fromAddress: TREASURY,
      nonce: 7,
      lookbackBlocks: 20n,
    });
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('bisects findOutgoingByNonce with a logarithmic number of RPC round trips', async () => {
    const tip = 20_000n;
    const foundBlock = 12_345n;
    const nonce = 7;
    const hash = `0x${'11'.repeat(32)}`;
    const counters = { getBlock: 0, getTransactionCount: 0 };

    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: mockTransport({
        tip,
        counters,
        countAtBlock: (blockNumber) => (blockNumber >= foundBlock ? nonce + 1 : nonce),
        transfersByBlock: new Map([
          [
            foundBlock,
            [
              {
                hash,
                from: TREASURY,
                to: OTHER,
                value: '0x1',
                nonce: `0x${nonce.toString(16)}`,
                type: '0x2',
              },
            ],
          ],
        ]),
      }),
    });

    const result = await scanner.findOutgoingByNonce({
      fromAddress: TREASURY,
      nonce,
      lookbackBlocks: 20_000n,
    });

    expect(result).toMatchObject({
      kind: 'found',
      transfer: { transactionHash: hash, nonce, blockNumber: foundBlock },
    });
    // ~⌈log₂(20000)⌉ ≈ 15 bisect probes + before-window + tip probes, plus one getBlock.
    // A sweep would be ~20001 getBlock calls — fail loudly if we regress.
    expect(counters.getBlock).toBe(1);
    expect(counters.getTransactionCount).toBeLessThanOrEqual(40);
    expect(counters.getTransactionCount).toBeGreaterThan(0);
  });

  it('fails closed to incomplete when a bisect count probe errors', async () => {
    const scanner = createTreasuryOutgoingScanner({
      chain: chainConfig(),
      logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
      transport: custom({
        request({ method }) {
          if (method === 'eth_chainId') {
            return Promise.resolve(`0x${SEPOLIA_CHAIN_ID.toString(16)}`);
          }
          if (method === 'eth_blockNumber') {
            return Promise.resolve('0x100');
          }
          if (method === 'eth_getTransactionCount') {
            return Promise.reject(new Error('rpc down'));
          }
          return Promise.reject(new Error(`Unhandled ${method}`));
        },
      }),
    });

    const result = await scanner.findOutgoingByNonce({
      fromAddress: TREASURY,
      nonce: 1,
      lookbackBlocks: 50n,
    });
    expect(result).toMatchObject({ kind: 'incomplete', errorCode: 'RPC_UNAVAILABLE' });
  });
});
