import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerConfiguredTreasuries } from '../../src/app/bootstrap/register-configured-treasury.js';
import { loadConfig, type ChainBankConfig } from '../../src/config/index.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import { chains, treasuries } from '../../src/infrastructure/db/schema.js';
import { validWebEnv } from '../support/env.js';
import {
  createIntegrationDatabase,
  isPgError,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const PUBLIC_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OPERATIONAL_ADDRESS = '0x0000000000000000000000000000000000000001';
const PUBLIC_ADDRESS_LOWER = PUBLIC_ADDRESS.toLowerCase();
const OPERATIONAL_ADDRESS_LOWER = OPERATIONAL_ADDRESS.toLowerCase();

const SINGULAR_KEYS = [
  'CHAIN_ID',
  'CHAIN_RPC_URL',
  'TREASURY_ADDRESS',
  'TREASURY_WARNING_BALANCE_ETH',
  'TREASURY_CRITICAL_BALANCE_ETH',
  'TREASURY_RECOVERY_BALANCE_ETH',
  'TREASURY_MINIMUM_RESERVE_ETH',
] as const;

describe.skipIf(!integrationEnabled)('register Base Sepolia treasuries (integration)', () => {
  let handle: IntegrationDatabaseHandle;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('registers the same two-tier addresses on both chains, idempotently, without a second enabled kind', async () => {
    const dependencies = {
      chains: createChainRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
    };

    const sepoliaOnly = await registerConfiguredTreasuries(dependencies, singularSepoliaConfig());
    const sepoliaExternalId = sepoliaOnly.chains[0]?.external.id;
    const sepoliaOperationalId = sepoliaOnly.chains[0]?.operational?.id;
    expect(sepoliaOnly.chains).toHaveLength(1);
    expect(sepoliaExternalId).toBeDefined();
    expect(sepoliaOperationalId).toBeDefined();

    const firstBoth = await registerConfiguredTreasuries(dependencies, twoChainConfig());
    const secondBoth = await registerConfiguredTreasuries(dependencies, twoChainConfig());

    expect(firstBoth.chains.map((entry) => entry.chainId)).toEqual([11155111, 84532]);
    expect(idsOf(firstBoth)).toEqual(idsOf(secondBoth));
    expect(firstBoth.chains[0]?.external.id).toBe(sepoliaExternalId);
    expect(firstBoth.chains[0]?.operational?.id).toBe(sepoliaOperationalId);
    expect(firstBoth.chains[1]?.external.id).not.toBe(sepoliaExternalId);
    expect(firstBoth.chains[1]?.operational?.id).not.toBe(sepoliaOperationalId);

    const rows = await handle.db
      .select({
        address: treasuries.address,
        kind: treasuries.kind,
        enabled: treasuries.enabled,
        chainId: chains.chainId,
      })
      .from(treasuries)
      .innerJoin(chains, eq(treasuries.chainId, chains.id));

    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.enabled)).toHaveLength(4);
    for (const chainId of [11155111, 84532]) {
      const onChain = rows.filter((row) => row.chainId === chainId);
      expect(onChain.map((row) => row.kind).sort()).toEqual(['external', 'operational']);
      expect(onChain.find((row) => row.kind === 'external')?.address).toBe(PUBLIC_ADDRESS_LOWER);
      expect(onChain.find((row) => row.kind === 'operational')?.address).toBe(OPERATIONAL_ADDRESS_LOWER);
    }

    const sepoliaChain = await handle.db.query.chains.findFirst({
      where: eq(chains.chainId, 11155111),
    });
    expect(sepoliaChain).toBeDefined();
    if (sepoliaChain === undefined) {
      return;
    }

    await expect(
      handle.db.insert(treasuries).values({
        chainId: sepoliaChain.id,
        address: '0x5555555555555555555555555555555555555555',
        addressDisplay: '0x5555555555555555555555555555555555555555',
        warningBalanceWei: '1000000000000000000',
        criticalBalanceWei: '250000000000000000',
        recoveryBalanceWei: '2000000000000000000',
        minimumReserveWei: '100000000000000000',
        kind: 'external',
        enabled: true,
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));

    const afterRefusal = await handle.db.select({ id: treasuries.id }).from(treasuries);
    expect(afterRefusal).toHaveLength(4);
  });

  it('registers hatch treasuries on both chains twice without a second external row', async () => {
    const dependencies = {
      chains: createChainRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
    };
    const config = twoChainConfig({ hatch: true });
    const first = await registerConfiguredTreasuries(dependencies, config);
    const second = await registerConfiguredTreasuries(dependencies, config);

    expect(first.chains.every((entry) => entry.operational === undefined)).toBe(true);
    expect(idsOf(first)).toEqual(idsOf(second));

    const rows = await handle.db
      .select({ kind: treasuries.kind, chainId: chains.chainId, address: treasuries.address })
      .from(treasuries)
      .innerJoin(chains, eq(treasuries.chainId, chains.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'external' && row.address === PUBLIC_ADDRESS_LOWER)).toBe(true);
    expect(rows.map((row) => row.chainId).sort((left, right) => left - right)).toEqual([84532, 11155111]);
  });
});

function idsOf(registered: Awaited<ReturnType<typeof registerConfiguredTreasuries>>): readonly string[] {
  return registered.chains.flatMap((entry) =>
    entry.operational === undefined ? [entry.external.id] : [entry.external.id, entry.operational.id],
  );
}

function treasuryDocument(address: string) {
  return {
    address,
    warningBalanceEth: '1',
    criticalBalanceEth: '0.25',
    recoveryBalanceEth: '2',
    minimumReserveEth: '0.1',
  };
}

function operationalDocument(address: string) {
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

function singularSepoliaConfig(): ChainBankConfig {
  return loadConfig({
    serviceRole: 'treasury-monitor',
    env: validWebEnv({
      TREASURY_ADDRESS: PUBLIC_ADDRESS,
      TREASURY_WARNING_BALANCE_ETH: '1',
      TREASURY_CRITICAL_BALANCE_ETH: '0.25',
      TREASURY_RECOVERY_BALANCE_ETH: '2',
      TREASURY_MINIMUM_RESERVE_ETH: '0.1',
      TREASURY_OPERATIONAL_ADDRESS: OPERATIONAL_ADDRESS,
      TREASURY_OPERATIONAL_WARNING_BALANCE_ETH: '0.2',
      TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH: '0.1',
      TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH: '0.4',
      TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH: '0.05',
      TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH: '0.15',
      TREASURY_OPERATIONAL_TARGET_BALANCE_ETH: '0.3',
      TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH: '0.2',
    }),
  });
}

function twoChainConfig(options: { readonly hatch?: boolean } = {}): ChainBankConfig {
  const operational = options.hatch === true ? undefined : operationalDocument(OPERATIONAL_ADDRESS);
  const documents = [11155111, 84532].map((chainId) => ({
    chainId,
    rpcUrl: `https://rpc.example.test/${String(chainId)}`,
    treasury: treasuryDocument(PUBLIC_ADDRESS),
    ...(operational === undefined ? {} : { operationalTreasury: operational }),
  }));
  const env = validWebEnv();
  for (const key of SINGULAR_KEYS) {
    delete env[key];
  }
  return loadConfig({
    serviceRole: 'treasury-monitor',
    env: { ...env, CHAINS: JSON.stringify(documents) },
  });
}
