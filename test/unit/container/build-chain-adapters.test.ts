import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import type { BalanceReader } from '../../../src/app/ports.js';
import { loadConfig, type ChainBankConfig } from '../../../src/config/index.js';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../../src/config/supported-chains.js';
import { buildChainAdapters } from '../../../src/container.js';
import { createLogger } from '../../../src/observability/logger.js';
import { validWebEnv } from '../../support/env.js';

const recorded = vi.hoisted(() => {
  const addresses = new Map<string, string>();
  let next = 0;
  return {
    readers: [] as Array<{ chainId: number; rpcUrl: string }>,
    reads: [] as Array<{ readerChainId: number; readerRpcUrl: string; requestChainId: number }>,
    signers: [] as Array<{
      chainId: number;
      rpcUrl: string;
      privateKey: string;
      allowedDestinationAddresses: readonly string[] | undefined;
    }>,
    addressFor(privateKey: string): string {
      const existing = addresses.get(privateKey);
      if (existing !== undefined) {
        return existing;
      }
      next += 1;
      const address = `0x${next.toString(16).padStart(40, '0')}`;
      addresses.set(privateKey, address);
      return address;
    },
  };
});

vi.mock('../../../src/infrastructure/evm/balance-reader.js', () => ({
  createBalanceReader: (options: { chain: { chainId: number; rpcUrl: string } }) => {
    recorded.readers.push({ chainId: options.chain.chainId, rpcUrl: options.chain.rpcUrl });
    return {
      chainId: options.chain.chainId,
      rpcUrl: options.chain.rpcUrl,
      readBalance: (request: { chainId: number }) => {
        recorded.reads.push({
          readerChainId: options.chain.chainId,
          readerRpcUrl: options.chain.rpcUrl,
          requestChainId: request.chainId,
        });
        return Promise.resolve({ kind: 'unavailable' as const, errorCode: 'RPC_UNAVAILABLE' });
      },
      verifyChainId: () => Promise.resolve({ matches: true, observedChainId: options.chain.chainId }),
    };
  },
}));

vi.mock('../../../src/infrastructure/evm/transaction-tracker.js', () => ({
  createTransactionReceiptTracker: (options: { chain: { chainId: number; rpcUrl: string } }) => ({
    chainId: options.chain.chainId,
    rpcUrl: options.chain.rpcUrl,
  }),
}));

vi.mock('../../../src/infrastructure/evm/treasury-outgoing-scanner.js', () => ({
  createTreasuryOutgoingScanner: (options: { chain: { chainId: number; rpcUrl: string } }) => ({
    chainId: options.chain.chainId,
    rpcUrl: options.chain.rpcUrl,
  }),
}));

vi.mock('../../../src/infrastructure/evm/treasury-signer.js', () => ({
  createTreasurySigner: (options: {
    chain: { chainId: number; rpcUrl: string };
    privateKey: string;
    allowedDestinationAddresses?: readonly string[];
  }) => {
    recorded.signers.push({
      chainId: options.chain.chainId,
      rpcUrl: options.chain.rpcUrl,
      privateKey: options.privateKey,
      allowedDestinationAddresses: options.allowedDestinationAddresses,
    });
    return {
      address: recorded.addressFor(options.privateKey),
      chainId: options.chain.chainId,
      sendNativeTransfer: () => Promise.reject(new Error('unused')),
      getTransactionCount: () => Promise.reject(new Error('unused')),
      estimateTransferCostWei: () => Promise.reject(new Error('unused')),
      verifyChainId: () => Promise.resolve({ matches: true, observedChainId: options.chain.chainId }),
    };
  },
}));

const FIXTURE_CHAIN: SupportedChain = {
  slug: 'fixture-chain',
  chainId: 424242,
  displayName: 'Fixture Chain',
  nativeSymbol: 'ETH',
  defaultExplorerBaseUrl: 'https://fixture.example',
  blockTimeMs: 2_000,
};

const SEPOLIA_RPC = 'https://rpc.example.test/sepolia';
const FIXTURE_RPC = 'https://rpc.example.test/fixture';
const SEPOLIA_TREASURY = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FIXTURE_TREASURY = '0x0000000000000000000000000000000000000002';
const SEPOLIA_OPERATIONAL = '0x0000000000000000000000000000000000000001';
const FIXTURE_OPERATIONAL = '0x0000000000000000000000000000000000000003';

function requireSepolia(): SupportedChain {
  const chain = SUPPORTED_CHAINS[0];
  if (chain === undefined) {
    throw new Error('SUPPORTED_CHAINS is empty');
  }
  return chain;
}

function treasury(address: string) {
  return {
    address,
    warningBalanceEth: '0.75',
    criticalBalanceEth: '0.3',
    recoveryBalanceEth: '1.5',
    minimumReserveEth: '0.1',
  };
}

function operational(address: string) {
  return {
    address,
    warningBalanceEth: '0.2',
    criticalBalanceEth: '0.1',
    recoveryBalanceEth: '0.4',
    minimumReserveEth: '0.05',
    minimumBalanceEth: '0.15',
    targetBalanceEth: '0.3',
    maximumTopUpEth: '0.2',
  };
}

function twoChainEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = validWebEnv();
  for (const key of [
    'CHAIN_ID',
    'CHAIN_RPC_URL',
    'TREASURY_ADDRESS',
    'TREASURY_WARNING_BALANCE_ETH',
    'TREASURY_CRITICAL_BALANCE_ETH',
    'TREASURY_RECOVERY_BALANCE_ETH',
    'TREASURY_MINIMUM_RESERVE_ETH',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    CHAINS: JSON.stringify([
      {
        chainId: 11155111,
        rpcUrl: SEPOLIA_RPC,
        treasury: treasury(SEPOLIA_TREASURY),
        operationalTreasury: operational(SEPOLIA_OPERATIONAL),
      },
      {
        chainId: FIXTURE_CHAIN.chainId,
        rpcUrl: FIXTURE_RPC,
        treasury: treasury(FIXTURE_TREASURY),
        operationalTreasury: operational(FIXTURE_OPERATIONAL),
      },
    ]),
    ...overrides,
  };
}

function twoChainConfig(
  role: ChainBankConfig['app']['serviceRole'],
  env: NodeJS.ProcessEnv,
): ChainBankConfig {
  return loadConfig({
    serviceRole: role,
    env,
    supportedChains: [requireSepolia(), FIXTURE_CHAIN],
  });
}

describe('buildChainAdapters', () => {
  beforeEach(() => {
    recorded.readers.length = 0;
    recorded.reads.length = 0;
    recorded.signers.length = 0;
  });

  it('binds each chain id to the reader constructed for that chain rpc', () => {
    const registry = buildChainAdapters(
      twoChainConfig('treasury-monitor', twoChainEnv()),
      { now: () => new Date('2026-09-21T00:00:00.000Z') },
      createLogger({ level: 'silent', serviceRole: 'treasury-monitor', environment: 'test' }),
    );
    const sepolia = registry.balanceReader(11155111) as BalanceReader & { rpcUrl: string };
    const fixture = registry.balanceReader(424242) as BalanceReader & { rpcUrl: string };

    expect(sepolia.chainId).toBe(11155111);
    expect(fixture.chainId).toBe(424242);
    expect(sepolia.rpcUrl).toBe(SEPOLIA_RPC);
    expect(fixture.rpcUrl).toBe(FIXTURE_RPC);
    expect(sepolia).not.toBe(fixture);
    expect(recorded.readers).toEqual([
      { chainId: 11155111, rpcUrl: SEPOLIA_RPC },
      { chainId: 424242, rpcUrl: FIXTURE_RPC },
    ]);
    expect(recorded.signers).toEqual([]);
  });

  it('builds one signer per chain from the same key, allowlisted to that chain', () => {
    const externalKey = generatePrivateKey();
    const operationalKey = generatePrivateKey();
    const config = twoChainConfig(
      'web',
      twoChainEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: externalKey,
        TREASURY_OPERATIONAL_PRIVATE_KEY: operationalKey,
      }),
    );
    const registry = buildChainAdapters(
      config,
      { now: () => new Date('2026-09-21T00:00:00.000Z') },
      createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    );

    const sepoliaReader = registry.balanceReader(11155111) as BalanceReader & { rpcUrl: string };
    const fixtureReader = registry.balanceReader(424242) as BalanceReader & { rpcUrl: string };
    expect(sepoliaReader.rpcUrl).toBe(SEPOLIA_RPC);
    expect(fixtureReader.rpcUrl).toBe(FIXTURE_RPC);
    expect(sepoliaReader).not.toBe(fixtureReader);

    const externalCalls = recorded.signers.filter((call) => call.privateKey === externalKey);
    const operationalCalls = recorded.signers.filter((call) => call.privateKey === operationalKey);
    expect(externalCalls.map((call) => call.chainId).sort((a, b) => a - b)).toEqual(
      [424242, 11155111].sort((a, b) => a - b),
    );
    expect(operationalCalls).toHaveLength(2);
    expect(new Set(externalCalls.map((call) => call.privateKey)).size).toBe(1);
    expect(externalCalls.find((call) => call.chainId === 11155111)?.rpcUrl).toBe(SEPOLIA_RPC);
    expect(externalCalls.find((call) => call.chainId === 424242)?.rpcUrl).toBe(FIXTURE_RPC);
    expect(externalCalls.find((call) => call.chainId === 11155111)?.allowedDestinationAddresses).toEqual([
      SEPOLIA_OPERATIONAL,
    ]);
    expect(externalCalls.find((call) => call.chainId === 424242)?.allowedDestinationAddresses).toEqual([
      FIXTURE_OPERATIONAL,
    ]);

    const sepoliaSigner = registry.getSignerForTreasury({
      id: 'treasury-sepolia',
      address: recorded.addressFor(externalKey),
      chain: { chainId: 11155111 },
    });
    const fixtureSigner = registry.getSignerForTreasury({
      id: 'treasury-fixture',
      address: recorded.addressFor(externalKey),
      chain: { chainId: 424242 },
    });
    expect(sepoliaSigner.chainId).toBe(11155111);
    expect(fixtureSigner.chainId).toBe(424242);
    expect(sepoliaSigner).not.toBe(fixtureSigner);
    expect(registry.externalSigner(11155111)?.chainId).toBe(11155111);
    expect(registry.externalSigner(424242)?.chainId).toBe(424242);
    expect(registry.externalSigner(11155111)).not.toBe(registry.externalSigner(424242));
  });

  it('sends a Base balance read to the Base reader and resolves one signer per chain for a shared address', async () => {
    const externalKey = generatePrivateKey();
    const operationalKey = generatePrivateKey();
    const sharedExternal = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const sharedOperational = '0x0000000000000000000000000000000000000001';
    const baseRpc = 'https://rpc.example.test/base-sepolia';
    const env = validWebEnv({
      FUNDING_ENABLED: 'true',
      TREASURY_PRIVATE_KEY: externalKey,
      TREASURY_OPERATIONAL_PRIVATE_KEY: operationalKey,
    });
    for (const key of [
      'CHAIN_ID',
      'CHAIN_RPC_URL',
      'TREASURY_ADDRESS',
      'TREASURY_WARNING_BALANCE_ETH',
      'TREASURY_CRITICAL_BALANCE_ETH',
      'TREASURY_RECOVERY_BALANCE_ETH',
      'TREASURY_MINIMUM_RESERVE_ETH',
    ]) {
      delete env[key];
    }
    const config = loadConfig({
      serviceRole: 'web',
      env: {
        ...env,
        CHAINS: JSON.stringify([
          {
            chainId: 11155111,
            rpcUrl: SEPOLIA_RPC,
            treasury: treasury(sharedExternal),
            operationalTreasury: operational(sharedOperational),
          },
          {
            chainId: 84532,
            rpcUrl: baseRpc,
            treasury: treasury(sharedExternal),
            operationalTreasury: operational(sharedOperational),
          },
        ]),
      },
    });
    expect(config.chains.map((chain) => chain.treasury.address)).toEqual([sharedExternal, sharedExternal]);
    expect(config.chains.map((chain) => chain.operationalTreasury?.address)).toEqual([
      sharedOperational,
      sharedOperational,
    ]);

    const registry = buildChainAdapters(
      config,
      { now: () => new Date('2026-09-22T00:00:00.000Z') },
      createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    );
    const sepoliaReader = registry.balanceReader(11155111) as BalanceReader & { rpcUrl: string };
    const baseReader = registry.balanceReader(84532) as BalanceReader & { rpcUrl: string };
    expect(baseReader.chainId).toBe(84532);
    expect(baseReader.rpcUrl).toBe(baseRpc);
    expect(sepoliaReader.rpcUrl).toBe(SEPOLIA_RPC);
    expect(baseReader).not.toBe(sepoliaReader);

    await baseReader.readBalance({ chainId: 84532, address: sharedExternal });
    expect(recorded.reads).toEqual([{ readerChainId: 84532, readerRpcUrl: baseRpc, requestChainId: 84532 }]);

    const signerAddress = recorded.addressFor(externalKey);
    const sepoliaSigner = registry.getSignerForTreasury({
      id: 'treasury-sepolia',
      address: signerAddress,
      chain: { chainId: 11155111 },
    });
    const baseSigner = registry.getSignerForTreasury({
      id: 'treasury-base',
      address: signerAddress,
      chain: { chainId: 84532 },
    });
    expect(sepoliaSigner.chainId).toBe(11155111);
    expect(baseSigner.chainId).toBe(84532);
    expect(sepoliaSigner).not.toBe(baseSigner);
    expect(registry.externalSigner(84532)?.chainId).toBe(84532);
    expect(registry.externalSigner(84532)).not.toBe(registry.externalSigner(11155111));
    expect(
      recorded.signers.find((call) => call.chainId === 84532 && call.privateKey === externalKey)?.rpcUrl,
    ).toBe(baseRpc);
  });
});
