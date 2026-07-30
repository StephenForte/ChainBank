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

describe('render.yaml treasury thresholds', () => {
  const services = serviceBlocks();

  it('declares both the web service and the treasury-monitor cron', () => {
    expect([...services.keys()]).toEqual(
      expect.arrayContaining(['chainbank-web', 'chainbank-treasury-monitor']),
    );
  });

  it.each(['chainbank-web', 'chainbank-treasury-monitor'])(
    'declares a valid threshold ladder for %s',
    (serviceName) => {
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
    },
  );

  it('declares identical thresholds on every service', () => {
    // Both processes upsert the same treasury row, so divergent values would
    // flip the row's thresholds back and forth on each boot and cron run.
    for (const key of THRESHOLD_KEYS) {
      const distinct = new Set(
        [...services.values()].map((block) => declaredValue(block, key)).filter((v) => v !== undefined),
      );
      expect(distinct.size, `${key} differs between services in render.yaml`).toBe(1);
    }
  });
});
