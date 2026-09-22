import { describe, expect, it } from 'vitest';
import {
  registerConfiguredTreasuries,
  summarizeRegisteredTreasuries,
  type RegisteredChainTreasuries,
} from '../../../../src/app/bootstrap/register-configured-treasury.js';
import type {
  ChainDescriptor,
  ChainRepository,
  Treasury,
  TreasuryRegistration,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
import { loadConfig } from '../../../../src/config/index.js';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../../../src/config/supported-chains.js';
import { validWebEnv } from '../../../support/env.js';

const FIXTURE_CHAIN: SupportedChain = {
  slug: 'fixture-chain',
  chainId: 424242,
  displayName: 'Fixture Chain',
  nativeSymbol: 'ETH',
  defaultExplorerBaseUrl: 'https://fixture.example',
  blockTimeMs: 2_000,
};

function requireSepolia(): SupportedChain {
  const chain = SUPPORTED_CHAINS[0];
  if (chain === undefined) {
    throw new Error('SUPPORTED_CHAINS is empty');
  }
  return chain;
}

function treasuryRow(id: string, registration: TreasuryRegistration, chain: ChainDescriptor): Treasury {
  return {
    id,
    chain,
    address: registration.address,
    addressDisplay: registration.addressDisplay,
    kind: registration.kind,
    policy: registration.policy,
    thresholds: registration.thresholds,
    status: 'unknown',
    lastObservedBalanceWei: undefined,
    lastObservedAt: undefined,
    lastCheckedAt: undefined,
    lastCheckErrorCode: undefined,
    lastOutgoingScanBlock: undefined,
    lastOutgoingScanAt: undefined,
    lastOutgoingScanNonce: undefined,
    enabled: true,
  };
}

function fakeDependencies(): {
  readonly chains: ChainRepository;
  readonly treasuries: TreasuryRepository;
  readonly treasuryUpserts: TreasuryRegistration[];
} {
  const treasuryUpserts: TreasuryRegistration[] = [];
  let next = 0;
  const unused = (): Promise<never> => Promise.reject(new Error('unused'));
  const chains: ChainRepository = {
    upsert(registration) {
      const descriptor: ChainDescriptor = {
        id: `chain-${String(registration.chainId)}`,
        slug: registration.slug,
        chainId: registration.chainId,
        displayName: registration.displayName,
        nativeSymbol: registration.nativeSymbol,
        explorerBaseUrl: registration.explorerBaseUrl,
      };
      return Promise.resolve(descriptor);
    },
    findByNumericChainId() {
      return Promise.resolve(undefined);
    },
  };
  const treasuries: TreasuryRepository = {
    upsert(registration) {
      next += 1;
      const row = treasuryRow(`treasury-${String(next)}`, registration, {
        id: `chain-${String(registration.chainRowId)}`,
        slug: 'pending',
        chainId: 0,
        displayName: 'pending',
        nativeSymbol: 'ETH',
        explorerBaseUrl: 'https://example.test',
      });
      treasuryUpserts.push(registration);
      return Promise.resolve(row);
    },
    findById: () => unused(),
    listEnabled: () => unused(),
    setEnabled: () => unused(),
    recordCheckSuccess: () => unused(),
    recordCheckFailure: () => unused(),
    recordOutgoingScanComplete: () => unused(),
  };
  return { chains, treasuries, treasuryUpserts };
}

function chainDocument(chainId: number, rpcUrl: string, address: string) {
  return {
    chainId,
    rpcUrl,
    treasury: {
      address,
      warningBalanceEth: '0.75',
      criticalBalanceEth: '0.3',
      recoveryBalanceEth: '1.5',
      minimumReserveEth: '0.1',
    },
  };
}

describe('registerConfiguredTreasuries', () => {
  it('registers every configured chain and summarizes each treasury id', async () => {
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
    const config = loadConfig({
      serviceRole: 'treasury-monitor',
      env: {
        ...env,
        CHAINS: JSON.stringify([
          chainDocument(
            11155111,
            'https://rpc.example.test/sepolia',
            '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          ),
          chainDocument(
            424242,
            'https://rpc.example.test/fixture',
            '0x0000000000000000000000000000000000000002',
          ),
        ]),
      },
      supportedChains: [requireSepolia(), FIXTURE_CHAIN],
    });
    const dependencies = fakeDependencies();
    const registered = await registerConfiguredTreasuries(dependencies, config);

    expect(registered.chains.map((entry: RegisteredChainTreasuries) => entry.chainId)).toEqual([
      11155111, 424242,
    ]);
    expect(dependencies.treasuryUpserts.map((row) => [row.chainRowId, row.kind])).toEqual([
      ['chain-11155111', 'external'],
      ['chain-424242', 'external'],
    ]);
    expect(summarizeRegisteredTreasuries(registered)).toEqual([
      { chainId: 11155111, treasuryId: 'treasury-1', operationalTreasuryId: undefined },
      { chainId: 424242, treasuryId: 'treasury-2', operationalTreasuryId: undefined },
    ]);
  });
});
