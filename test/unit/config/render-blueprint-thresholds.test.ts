import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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

  it('schedules the wallet reconciler every six hours', () => {
    const block = services.get('chainbank-wallet-reconciler') ?? '';
    expect(block).toMatch(/schedule:\s*'0 \*\/6 \* \* \*'/);
    expect(block).toMatch(/startCommand:\s*npm run cron:wallet-reconciler/);
  });
});
