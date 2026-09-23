import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { validWebEnv } from '../../support/env.js';

describe('RECONCILE_ABORTED_RUN_GRACE_MINUTES', () => {
  it('defaults to 60 minutes, longer than a two-scan run', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv(),
    });
    // Longest observed Base scan was 828s, and a run scans two treasuries.
    expect(config.reconciliation?.abortedRunGraceMinutes).toBe(60);
    expect((config.reconciliation?.abortedRunGraceMinutes ?? 0) * 60).toBeGreaterThan(828 * 2);
  });

  it('parses an explicit positive integer', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv({ RECONCILE_ABORTED_RUN_GRACE_MINUTES: '90' }),
    });
    expect(config.reconciliation?.abortedRunGraceMinutes).toBe(90);
  });

  it('rejects a non-positive window', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validWebEnv({ RECONCILE_ABORTED_RUN_GRACE_MINUTES: '0' }),
      }),
    ).toThrow(ChainBankError);
  });
});
