import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { DEFAULT_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND } from '../../../src/config/schema.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { validWebEnv } from '../../support/env.js';

describe('RECONCILE_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND', () => {
  it('parses a positive integer for the reconciler', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv({ RECONCILE_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND: '40' }),
    });
    expect(config.reconciliation?.outgoingScanMaxRequestsPerSecond).toBe(40);
  });

  it('defaults to 25', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv(),
    });
    expect(DEFAULT_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND).toBe(25);
    expect(config.reconciliation?.outgoingScanMaxRequestsPerSecond).toBe(25);
  });

  it('rejects non-positive values', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validWebEnv({ RECONCILE_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND: '0' }),
      }),
    ).toThrow(ChainBankError);

    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validWebEnv({ RECONCILE_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND: '-1' }),
      }),
    ).toThrow(ChainBankError);
  });
});
