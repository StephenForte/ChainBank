import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { getTreasuryPrivateKey, isSigningCapableRole, loadConfig } from '../../../src/config/index.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { validMonitorEnv, validWebEnv } from '../../support/env.js';

/** Reconciler env: email + optional signing material (mirrors monitor + funding). */
function validReconcilerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return validWebEnv(overrides);
}

describe('cron-reconciler config wiring', () => {
  it('marks web and cron-reconciler signing-capable; monitor is not', () => {
    expect(isSigningCapableRole('web')).toBe(true);
    expect(isSigningCapableRole('cron-reconciler')).toBe(true);
    expect(isSigningCapableRole('treasury-monitor')).toBe(false);
  });

  it('loads lookback blocks and email for the reconciler role', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validReconcilerEnv({ RECONCILE_OUTGOING_LOOKBACK_BLOCKS: '15000' }),
    });

    expect(config.app.serviceRole).toBe('cron-reconciler');
    expect(config.reconciliation?.outgoingLookbackBlocks).toBe(15_000);
    expect(config.email?.provider).toBe('log-only');
    expect(config.email?.operatorRecipients).toEqual(['operator@example.com']);
    expect(config.apiSecurity).toBeUndefined();
    expect(config.database.poolMax).toBe(2);
  });

  it('defaults RECONCILE_OUTGOING_LOOKBACK_BLOCKS to 20000', () => {
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validReconcilerEnv(),
    });
    expect(config.reconciliation?.outgoingLookbackBlocks).toBe(20_000);
  });

  it('rejects non-positive lookback blocks', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validReconcilerEnv({ RECONCILE_OUTGOING_LOOKBACK_BLOCKS: '0' }),
      }),
    ).toThrow(ChainBankError);

    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validReconcilerEnv({ RECONCILE_OUTGOING_LOOKBACK_BLOCKS: '-1' }),
      }),
    ).toThrow(ChainBankError);
  });

  it('requires email credentials for the reconciler (T4.3 alert wiring)', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validReconcilerEnv({
          EMAIL_FROM_ADDRESS: undefined,
          EMAIL_OPERATOR_RECIPIENTS: undefined,
        }),
      }),
    ).toThrow(ChainBankError);
  });

  it('accepts FUNDING_ENABLED=true with a disposable private key for reconciler', () => {
    const privateKey = generatePrivateKey();
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validReconcilerEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: privateKey,
      }),
    });

    expect(config.isFundingEnabled).toBe(true);
    expect(getTreasuryPrivateKey(config)).toBe(privateKey);
    expect(JSON.stringify(config.funding)).not.toContain(privateKey);
  });

  it('still strips TREASURY_PRIVATE_KEY for treasury-monitor after reconciler is signing-capable', () => {
    const privateKey = generatePrivateKey();
    const config = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: privateKey,
      }),
    });

    expect(config.isFundingEnabled).toBe(false);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
    expect(config.reconciliation).toBeUndefined();
  });

  it('does not attach reconciliation config to web or monitor', () => {
    expect(loadConfig({ serviceRole: 'web', env: validWebEnv() }).reconciliation).toBeUndefined();
    expect(
      loadConfig({ serviceRole: 'treasury-monitor', env: validMonitorEnv() }).reconciliation,
    ).toBeUndefined();
  });
});
