import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, type ServiceRole } from '../../../src/config/index.js';
import { DEFAULT_TRUSTED_PROXY_CIDRS } from '../../../src/config/trusted-proxy.js';
import { assertValidTreasuryThresholds } from '../../../src/domain/treasury/treasury-status.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';

/**
 * Treasury thresholds are declared in `render.yaml` rather than set in the
 * Render dashboard (decision D3), specifically so that an invalid ladder is
 * caught here instead of failing every service at boot — `buildTreasuryConfig`
 * runs unconditionally in `loadConfig`, so a bad value takes down the web
 * service and the monitor cron alike.
 *
 * This reads the Blueprint as text on purpose. A YAML parser would be a new
 * dependency for one assertion, and the flat `- key:` / `value:` shape here is
 * stable enough that matching it directly is honest rather than clever.
 */

const THRESHOLD_KEYS = [
  'TREASURY_WARNING_BALANCE_ETH',
  'TREASURY_CRITICAL_BALANCE_ETH',
  'TREASURY_RECOVERY_BALANCE_ETH',
  'TREASURY_MINIMUM_RESERVE_ETH',
] as const;

type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

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

/** Reads a declared literal env value, ignoring `sync: false` entries. */
function declaredValue(block: string, key: ThresholdKey): string | undefined {
  const pattern = new RegExp(`- key:\\s*${key}\\s*\\n\\s*value:\\s*'?([^'\\n]+)'?`);
  return pattern.exec(block)?.[1]?.trim();
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

/** Services that upsert the shared treasury row and must declare the D3 ladder. */
const THRESHOLD_SERVICES = [
  'chainbank-web',
  'chainbank-treasury-monitor',
  'chainbank-wallet-reconciler',
] as const;

describe('render.yaml treasury thresholds', () => {
  const services = serviceBlocks();

  it('declares the web service and both cron jobs', () => {
    expect([...services.keys()]).toEqual(expect.arrayContaining([...THRESHOLD_SERVICES]));
  });

  it.each(THRESHOLD_SERVICES)('declares a valid threshold ladder for %s', (serviceName) => {
    const block = services.get(serviceName);
    expect(block, `service ${serviceName} not found in render.yaml`).toBeDefined();

    const values = Object.fromEntries(
      THRESHOLD_KEYS.map((key) => [key, declaredValue(block ?? '', key)]),
    ) as Record<ThresholdKey, string | undefined>;

    for (const key of THRESHOLD_KEYS) {
      expect(values[key], `${key} must be a literal value in render.yaml, not sync:false`).toBeDefined();
    }

    const thresholds = {
      warningBalanceWei: parseEtherToWei(values.TREASURY_WARNING_BALANCE_ETH ?? '', 'warning'),
      criticalBalanceWei: parseEtherToWei(values.TREASURY_CRITICAL_BALANCE_ETH ?? '', 'critical'),
      recoveryBalanceWei: parseEtherToWei(values.TREASURY_RECOVERY_BALANCE_ETH ?? '', 'recovery'),
      minimumReserveWei: parseEtherToWei(values.TREASURY_MINIMUM_RESERVE_ETH ?? '', 'reserve'),
    };

    // The same check the services run at startup.
    expect(() => assertValidTreasuryThresholds(thresholds)).not.toThrow();

    // Keeps the critical alert meaningful: it must fire while funding still
    // has spendable headroom, not after the reserve has already halted it.
    expect(thresholds.minimumReserveWei).toBeLessThan(thresholds.criticalBalanceWei);
  });

  it('declares identical thresholds on every service', () => {
    // All three processes upsert the same treasury row, so divergent values would
    // flip the row's thresholds back and forth on each boot and cron run.
    for (const key of THRESHOLD_KEYS) {
      const distinct = new Set(
        [...services.values()].map((block) => declaredValue(block, key)).filter((v) => v !== undefined),
      );
      expect(distinct.size, `${key} differs between services in render.yaml`).toBe(1);
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
   * The inverse of the threshold rule above, and it is deliberate rather than
   * inconsistent. Thresholds are declared literals because an invalid ladder
   * must fail in CI. The funding gates are operator state: a literal value is
   * reapplied on every Blueprint sync, and Render re-syncs the whole Blueprint
   * whenever this file changes for any reason. On 2026-08-11 an unrelated
   * FUNDING_HEALTH_TOKEN commit re-declared FUNDING_ENABLED=false on
   * chainbank-wallet-reconciler, and unattended funding stopped for 18 hours
   * while every run still reported exit 0. The same mechanism would clear a
   * kill switch set mid-incident.
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

  const ROLE_BY_SERVICE: Readonly<Record<(typeof THRESHOLD_SERVICES)[number], ServiceRole>> = {
    'chainbank-web': 'web',
    'chainbank-treasury-monitor': 'treasury-monitor',
    'chainbank-wallet-reconciler': 'cron-reconciler',
  };

  /**
   * Values the Blueprint deliberately does not literalize (`sync: false` or
   * `fromDatabase`). They are stand-ins so `loadConfig` can run; the assertions
   * below check that the literals the file does declare survive that load.
   */
  const SYNC_FALSE_STAND_INS: Record<string, string> = {
    DATABASE_URL: 'postgres://localhost:5432/chainbank_blueprint',
    DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    CHAIN_RPC_URL: 'https://rpc.example.test/sepolia',
    TREASURY_ADDRESS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    EMAIL_FROM_ADDRESS: 'chainbank@example.com',
    EMAIL_OPERATOR_RECIPIENTS: 'operator@example.com',
    RESEND_API_KEY: 're_blueprint_test',
    PUBLIC_BASE_URL: 'https://chainbank.example',
  };

  it.each(THRESHOLD_SERVICES)(
    'loads %s as one Sepolia chain from the singular env the blueprint still declares',
    (serviceName) => {
      const block = services.get(serviceName) ?? '';
      expect(block, `${serviceName} must not declare CHAINS beside the singular keys`).not.toMatch(
        /- key:\s*CHAINS\b/,
      );

      const declared = literalEnv(block);
      expect(declared.CHAIN_ID).toBe('11155111');
      const config = loadConfig({
        serviceRole: ROLE_BY_SERVICE[serviceName],
        env: { ...SYNC_FALSE_STAND_INS, ...declared },
      });

      expect(config.chains).toHaveLength(1);
      expect(config.defaultChainId).toBe(11155111);
      const chain = config.chains[0];
      expect(chain?.slug).toBe('ethereum-sepolia');
      expect(chain?.chainId).toBe(11155111);
      expect(chain?.displayName).toBe('Ethereum Sepolia');
      expect(chain?.nativeSymbol).toBe('ETH');
      expect(chain?.rpcUrl).toBe(SYNC_FALSE_STAND_INS.CHAIN_RPC_URL);
      expect(chain?.explorerBaseUrl).toBe('https://sepolia.etherscan.io');
      expect(chain?.treasury.address).toBe(SYNC_FALSE_STAND_INS.TREASURY_ADDRESS);
      expect(chain?.treasury.warningBalanceWei).toBe(parseEtherToWei('0.75', 'warning'));
      expect(chain?.treasury.criticalBalanceWei).toBe(parseEtherToWei('0.3', 'critical'));
      expect(chain?.treasury.recoveryBalanceWei).toBe(parseEtherToWei('1.5', 'recovery'));
      expect(chain?.treasury.minimumReserveWei).toBe(parseEtherToWei('0.1', 'reserve'));
      expect(chain?.operationalTreasury).toBeUndefined();
      expect(config.chain.chainId).toBe(chain?.chainId);
      expect(config.treasury.warningBalanceWei).toBe(chain?.treasury.warningBalanceWei);
    },
  );

  it('schedules the wallet reconciler every six hours', () => {
    const block = services.get('chainbank-wallet-reconciler') ?? '';
    expect(block).toMatch(/schedule:\s*'0 \*\/6 \* \* \*'/);
    expect(block).toMatch(/startCommand:\s*npm run cron:wallet-reconciler/);
  });
});
