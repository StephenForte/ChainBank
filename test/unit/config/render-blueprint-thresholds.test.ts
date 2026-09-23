import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, type ServiceRole } from '../../../src/config/index.js';
import { SINGULAR_CHAIN_ENV_KEYS } from '../../../src/config/schema.js';
import { DEFAULT_TRUSTED_PROXY_CIDRS } from '../../../src/config/trusted-proxy.js';

/**
 * `render.yaml` declares the multi-chain form. `CHAINS` is `sync: false` with
 * no value, so the Render dashboard document stays authoritative across
 * Blueprint syncs (CB-04). The singular chain keys must not appear: `loadConfig`
 * throws INVALID_CONFIGURATION when any of them is set beside `CHAINS`, and a
 * sync that re-applied them would take every service down.
 *
 * Threshold numbers live inside the dashboard `CHAINS` document, not as
 * literals in this file. This test does not know those numbers. It imports
 * `SINGULAR_CHAIN_ENV_KEYS` and refuses the list, and it loads a stand-in
 * two-chain document through `loadConfig` for each service role.
 *
 * This reads the Blueprint as text on purpose. A YAML parser would be a new
 * dependency for one assertion, and the flat `- key:` / `value:` shape here is
 * stable enough that matching it directly is honest rather than clever.
 */

const blueprint = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');

/** Splits the Blueprint into one text block per service, keyed by service name. */
function serviceBlocks(): ReadonlyMap<string, string> {
  const blocks = new Map<string, string>();
  const chunks = blueprint.split(/^ {2}- type: /m).slice(1);
  for (const chunk of chunks) {
    const name = /^\s*name:\s*(\S+)/m.exec(chunk)?.[1];
    if (name !== undefined) {
      blocks.set(name, chunk);
    }
  }
  return blocks;
}

/** The `- key:` entry through the line before the next key, or the end of the block. */
function envEntry(block: string, key: string): string | undefined {
  const match = new RegExp(`- key:\\s*${key}\\b([^]*?)(?=\\n\\s*- key:|$)`).exec(block);
  return match?.[0];
}

/** Every literal `key` / `value` pair in a service block. `sync: false` entries are absent. */
function literalEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  const pattern = /- key:\s*([A-Z0-9_]+)\s*\n\s*value:\s*'?([^'\n]+)'?/g;
  for (const match of block.matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      env[key] = value.trim();
    }
  }
  return env;
}

/** Services that boot from the shared Blueprint and must agree on chain configuration. */
const BLUEPRINT_SERVICES = [
  'chainbank-web',
  'chainbank-treasury-monitor',
  'chainbank-wallet-reconciler',
] as const;

describe('render.yaml chain configuration', () => {
  const services = serviceBlocks();

  it('declares the web service and both cron jobs', () => {
    expect([...services.keys()]).toEqual(expect.arrayContaining([...BLUEPRINT_SERVICES]));
  });

  it('declares none of the singular chain keys on any service', () => {
    for (const [serviceName, block] of services) {
      for (const key of SINGULAR_CHAIN_ENV_KEYS) {
        expect(block, `${key} must not be declared on ${serviceName}`).not.toMatch(
          new RegExp(`- key:\\s*${key}\\b`),
        );
      }
    }
  });

  it('declares CHAINS as sync:false with no value on every service', () => {
    for (const [serviceName, block] of services) {
      const entry = envEntry(block, 'CHAINS');
      expect(entry, `CHAINS is not declared on ${serviceName}`).toBeDefined();
      expect(
        entry,
        `CHAINS must be sync:false on ${serviceName}. A value is reapplied on every Blueprint sync.`,
      ).toMatch(/\n\s*sync:\s*false\b/);
      expect(
        entry,
        `CHAINS must not set value: on ${serviceName}. A literal would overwrite the dashboard document.`,
      ).not.toMatch(/\bvalue\s*:/);
    }
  });

  it('gives TREASURY_PRIVATE_KEY only to signing-capable services', () => {
    const hasSigningKey = (name: string): boolean => {
      const block = services.get(name) ?? '';
      return /- key:\s*TREASURY_PRIVATE_KEY\b/.test(block);
    };

    expect(hasSigningKey('chainbank-web')).toBe(true);
    expect(hasSigningKey('chainbank-wallet-reconciler')).toBe(true);
    expect(hasSigningKey('chainbank-treasury-monitor')).toBe(false);
  });

  it('gives TREASURY_OPERATIONAL_PRIVATE_KEY only to signing-capable services', () => {
    const hasOperationalKey = (name: string): boolean => {
      const block = services.get(name) ?? '';
      return /- key:\s*TREASURY_OPERATIONAL_PRIVATE_KEY\b/.test(block);
    };

    expect(hasOperationalKey('chainbank-web')).toBe(true);
    expect(hasOperationalKey('chainbank-wallet-reconciler')).toBe(true);
    expect(hasOperationalKey('chainbank-treasury-monitor')).toBe(false);
  });

  /**
   * Funding gates are operator state: a literal value is reapplied on every
   * Blueprint sync, and Render re-syncs the whole Blueprint whenever this file
   * changes for any reason. On 2026-08-11 an unrelated FUNDING_HEALTH_TOKEN
   * commit re-declared FUNDING_ENABLED=false on chainbank-wallet-reconciler,
   * and unattended funding stopped for 18 hours while every run still reported
   * exit 0. The same mechanism would clear a kill switch set mid-incident.
   *
   * Both keys default to false when unset (`src/config/schema.ts`), so
   * sync:false fails closed rather than arming funding by omission.
   */
  const FUNDING_GATE_KEYS = ['FUNDING_ENABLED', 'FUNDING_KILL_SWITCH'] as const;
  const SIGNING_SERVICES = ['chainbank-web', 'chainbank-wallet-reconciler'] as const;

  describe.each(SIGNING_SERVICES)('funding gates on %s', (serviceName) => {
    it.each(FUNDING_GATE_KEYS)('declares %s as sync:false, never a literal', (key) => {
      const block = services.get(serviceName) ?? '';
      const entry = new RegExp(`- key:\\s*${key}\\s*\\n\\s*(\\S+):`).exec(block);

      expect(entry, `${key} is not declared on ${serviceName}`).not.toBeNull();
      expect(
        entry?.[1],
        `${key} must be sync:false on ${serviceName}. A literal value is reapplied ` +
          'on every Blueprint sync and silently reverts the operator flip.',
      ).toBe('sync');
    });
  });

  it('keeps FUNDING_ENABLED a literal false on the non-signing monitor', () => {
    // Asymmetric on purpose: treasury-monitor holds no key and must never fund,
    // so reasserting false on each sync is the point.
    const block = services.get('chainbank-treasury-monitor') ?? '';
    expect(block).toMatch(/- key:\s*FUNDING_ENABLED\s*\n\s*value:\s*'false'/);
    expect(block).not.toMatch(/- key:\s*FUNDING_KILL_SWITCH\b/);
  });

  it('declares TRUSTED_PROXY_CIDRS on the web service', () => {
    const block = services.get('chainbank-web') ?? '';
    const declared = /- key:\s*TRUSTED_PROXY_CIDRS\s*\n\s*value:\s*'([^']+)'/.exec(block)?.[1];
    expect(declared).toBe(DEFAULT_TRUSTED_PROXY_CIDRS);
    // Joined so this assertion still fails if the Blueprint declares the
    // retired hop-count variable, without keeping that name as a live key.
    const retiredHopCountKey = ['TRUSTED', 'PROXY', 'HOPS'].join('_');
    expect(blueprint).not.toContain(retiredHopCountKey);
  });

  const ROLE_BY_SERVICE: Readonly<Record<(typeof BLUEPRINT_SERVICES)[number], ServiceRole>> = {
    'chainbank-web': 'web',
    'chainbank-treasury-monitor': 'treasury-monitor',
    'chainbank-wallet-reconciler': 'cron-reconciler',
  };

  /**
   * Values the Blueprint deliberately does not literalize (`sync: false` or
   * `fromDatabase`). They are stand-ins so `loadConfig` can run; the assertions
   * below check that the literals the file does declare survive that load.
   * `CHAINS` stands in for the dashboard document. It must not include any
   * singular key: those refuse to boot beside `CHAINS`.
   */
  const SYNC_FALSE_STAND_INS: Record<string, string> = {
    DATABASE_URL: 'postgres://localhost:5432/chainbank_blueprint',
    DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    EMAIL_FROM_ADDRESS: 'chainbank@example.com',
    EMAIL_OPERATOR_RECIPIENTS: 'operator@example.com',
    RESEND_API_KEY: 're_blueprint_test',
    PUBLIC_BASE_URL: 'https://chainbank.example',
    CHAINS: JSON.stringify([
      {
        chainId: 11155111,
        rpcUrl: 'https://rpc.example.test/sepolia',
        treasury: {
          address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          warningBalanceEth: '0.75',
          criticalBalanceEth: '0.3',
          recoveryBalanceEth: '1.5',
          minimumReserveEth: '0.1',
        },
      },
      {
        chainId: 84532,
        rpcUrl: 'https://rpc.example.test/base-sepolia',
        treasury: {
          address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          warningBalanceEth: '0.75',
          criticalBalanceEth: '0.3',
          recoveryBalanceEth: '1.5',
          minimumReserveEth: '0.1',
        },
      },
    ]),
  };

  it.each(BLUEPRINT_SERVICES)(
    'loads %s as Ethereum Sepolia and Base Sepolia from a stand-in CHAINS document',
    (serviceName) => {
      const block = services.get(serviceName) ?? '';
      const config = loadConfig({
        serviceRole: ROLE_BY_SERVICE[serviceName],
        env: { ...SYNC_FALSE_STAND_INS, ...literalEnv(block) },
      });

      expect(config.chains).toHaveLength(2);
      const [sepolia, base] = config.chains;
      expect(sepolia?.slug).toBe('ethereum-sepolia');
      expect(sepolia?.chainId).toBe(11155111);
      expect(sepolia?.displayName).toBe('Ethereum Sepolia');
      expect(sepolia?.rpcUrl).toBe('https://rpc.example.test/sepolia');
      expect(sepolia?.treasury.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
      expect(base?.slug).toBe('base-sepolia');
      expect(base?.chainId).toBe(84532);
      expect(base?.displayName).toBe('Base Sepolia');
      expect(base?.rpcUrl).toBe('https://rpc.example.test/base-sepolia');
      expect(base?.treasury.address).toBe(sepolia?.treasury.address);
    },
  );

  it('schedules the wallet reconciler every six hours', () => {
    const block = services.get('chainbank-wallet-reconciler') ?? '';
    expect(block).toMatch(/schedule:\s*'0 \*\/6 \* \* \*'/);
    expect(block).toMatch(/startCommand:\s*npm run cron:wallet-reconciler/);
  });
});
