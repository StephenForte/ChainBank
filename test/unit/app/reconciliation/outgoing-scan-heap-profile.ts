/**
 * Manual heap profile for TX.34. Not part of `npm test` (no `.test` suffix).
 *
 * Two back-to-back body scans over a recorded Base Sepolia block shape.
 * Pass the fixture path and block count:
 *
 *   BLOCKS=20001 FIXTURE=/path/to/sample-block.json \
 *     node --expose-gc --max-old-space-size=2048 --import tsx \
 *     test/unit/app/reconciliation/outgoing-scan-heap-profile.ts
 *
 * The process prints heapUsed after an explicit GC at baseline and after each scan.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { writeHeapSnapshot } from 'node:v8';
import { custom, type Transport } from 'viem';
import { createTreasuryOutgoingScanner } from '../../../../src/infrastructure/evm/treasury-outgoing-scanner.js';
import { createLogger } from '../../../../src/observability/logger.js';

const fixturePath = process.env.FIXTURE;
if (fixturePath === undefined || fixturePath.length === 0) {
  throw new Error('FIXTURE must be the path to a JSON-RPC eth_getBlockByNumber response');
}

const sample = readFixture(fixturePath);

const blockCount = Number(process.env.BLOCKS ?? '2000');
const scanCount = Number(process.env.SCANS ?? '2');
if (!Number.isInteger(blockCount) || blockCount <= 0) {
  throw new Error('BLOCKS must be a positive integer');
}

function memory(): { heapMb: number; heapTotalMb: number; rssMb: number; externalMb: number } {
  const usage = process.memoryUsage();
  return {
    heapMb: usage.heapUsed / (1024 * 1024),
    heapTotalMb: usage.heapTotal / (1024 * 1024),
    rssMb: usage.rss / (1024 * 1024),
    externalMb: usage.external / (1024 * 1024),
  };
}

function readFixture(path: string): Record<string, unknown> & {
  readonly transactions: readonly Record<string, unknown>[];
} {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
    throw new Error('fixture is not a JSON-RPC response');
  }
  const result = parsed.result;
  if (typeof result !== 'object' || result === null || !('transactions' in result)) {
    throw new Error('fixture result has no transactions');
  }
  const rawTransactions = result.transactions;
  if (!Array.isArray(rawTransactions)) {
    throw new Error('fixture transactions are not an array');
  }
  const transactions: Record<string, unknown>[] = [];
  for (const item of rawTransactions) {
    const tx: unknown = item;
    if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) {
      throw new Error('fixture transaction is not an object');
    }
    transactions.push(objectToRecord(tx));
  }
  return { ...objectToRecord(result), transactions };
}

function objectToRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    record[key] = Reflect.get(value, key) as unknown;
  }
  return record;
}

function collectGarbage(): void {
  const run = (globalThis as { gc?: () => void }).gc;
  if (run === undefined) {
    throw new Error('start node with --expose-gc');
  }
  run();
  run();
}

function blockAt(blockNumber: bigint): Record<string, unknown> {
  const hex = `0x${blockNumber.toString(16)}`;
  return {
    ...sample,
    number: hex,
    hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    transactions: sample.transactions.map((tx, index) => ({
      ...tx,
      blockNumber: hex,
      transactionIndex: `0x${index.toString(16)}`,
      hash: `0x${(blockNumber * 1000n + BigInt(index)).toString(16).padStart(64, '0')}`,
    })),
  };
}

let peak = memory();

function noteHeap(): void {
  const used = memory();
  if (used.heapMb > peak.heapMb) {
    peak = used;
  }
}

function transport(): Transport {
  return custom(
    {
      request({ method, params }) {
        noteHeap();
        switch (method) {
          case 'eth_chainId':
            return Promise.resolve('0x14a34');
          case 'eth_blockNumber':
            return Promise.resolve(`0x${(BigInt(blockCount) * BigInt(scanCount)).toString(16)}`);
          case 'eth_getTransactionCount':
            return Promise.resolve('0x0');
          case 'eth_getBlockByNumber': {
            const raw = (params as [string, boolean])[0];
            return Promise.resolve(blockAt(BigInt(raw)));
          }
          default:
            return Promise.reject(new Error(`unhandled ${method}`));
        }
      },
    },
    { retryCount: 0 },
  );
}

let now = 0;
const useHttp = process.env.HTTP === '1';
const httpServer = useHttp ? await startFixtureServer() : undefined;
const scanner = createTreasuryOutgoingScanner({
  chain: {
    slug: 'base-sepolia',
    chainId: 84_532,
    displayName: 'Base Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: httpServer?.url ?? 'https://rpc.example.test/base-sepolia',
    explorerBaseUrl: 'https://sepolia.basescan.org',
  },
  logger: createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' }),
  maxRequestsPerSecond: 100_000,
  ...(useHttp ? {} : { transport: transport() }),
  nowMs: () => now,
  sleep: (ms: number) => {
    now += ms;
    return Promise.resolve();
  },
});

const treasury = '0x1111111111111111111111111111111111111111';

collectGarbage();
const baseline = memory();
process.stdout.write(
  `${JSON.stringify({
    phase: 'baseline',
    ...roundMemory(baseline),
    blocks: blockCount,
    txsPerBlock: sample.transactions.length,
    fixtureBytes: readFileSync(fixturePath).byteLength,
    transport: useHttp ? 'http' : 'custom',
  })}\n`,
);

for (let scan = 0; scan < scanCount; scan += 1) {
  const fromBlock = BigInt(scan * blockCount + 1);
  const toBlock = BigInt((scan + 1) * blockCount);
  const started = Date.now();
  const result = await scanner.listOutgoingTransfers({
    fromAddress: treasury,
    fromBlock,
    toBlock,
  });
  const beforeGc = memory();
  if (process.env.SNAPSHOT === '1' && scan === 0) {
    const dir = process.env.SNAPSHOT_DIR;
    if (dir === undefined || dir.length === 0) {
      throw new Error('SNAPSHOT=1 requires SNAPSHOT_DIR');
    }
    writeHeapSnapshot(`${dir}/before-gc.heapsnapshot`);
    collectGarbage();
    writeHeapSnapshot(`${dir}/after-gc.heapsnapshot`);
  } else {
    collectGarbage();
  }
  process.stdout.write(
    `${JSON.stringify({
      phase: 'after-scan',
      scan,
      kind: result.kind,
      transfers: result.kind === 'ok' ? result.transfers.length : undefined,
      elapsedMs: Date.now() - started,
      beforeGc: roundMemory(beforeGc),
      ...roundMemory(memory()),
      peak: roundMemory(peak),
    })}\n`,
  );
}

if (httpServer !== undefined) {
  await new Promise<void>((resolve, reject) => {
    httpServer.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function startFixtureServer(): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    noteHeap();
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly method?: string;
        readonly params?: readonly unknown[];
      };
      const method = body.method ?? 'missing';
      let result: unknown;
      switch (method) {
        case 'eth_chainId':
          result = '0x14a34';
          break;
        case 'eth_blockNumber':
          result = `0x${(BigInt(blockCount) * BigInt(scanCount)).toString(16)}`;
          break;
        case 'eth_getTransactionCount':
          result = '0x0';
          break;
        case 'eth_getBlockByNumber': {
          const raw = body.params?.[0];
          result = blockAt(typeof raw === 'string' ? BigInt(raw) : 0n);
          break;
        }
        default:
          response.writeHead(400);
          response.end();
          return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('fixture server did not bind');
      }
      resolve({ server, url: `http://127.0.0.1:${String(address.port)}` });
    });
  });
}

function roundMemory(usage: { heapMb: number; heapTotalMb: number; rssMb: number; externalMb: number }): {
  heapMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
} {
  return {
    heapMb: Number(usage.heapMb.toFixed(2)),
    heapTotalMb: Number(usage.heapTotalMb.toFixed(2)),
    rssMb: Number(usage.rssMb.toFixed(2)),
    externalMb: Number(usage.externalMb.toFixed(2)),
  };
}
