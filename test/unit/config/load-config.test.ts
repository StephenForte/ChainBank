import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';
import { validMonitorEnv, validWebEnv } from '../../support/env.js';

describe('loadConfig', () => {
  it('loads a valid web configuration with integer-safe treasury thresholds', () => {
    const config = loadConfig({ serviceRole: 'web', env: validWebEnv() });

    expect(config.app.serviceRole).toBe('web');
    expect(config.chain.chainId).toBe(11155111);
    expect(config.treasury.warningBalanceWei).toBe(parseEtherToWei('1', 'w'));
    expect(config.email?.provider).toBe('log-only');
    expect(config.apiSecurity).toBeDefined();
    expect(config.isFundingEnabled).toBe(false);
  });

  it('loads the treasury monitor without requiring email credentials', () => {
    const config = loadConfig({ serviceRole: 'treasury-monitor', env: validMonitorEnv() });

    expect(config.app.serviceRole).toBe('treasury-monitor');
    expect(config.email).toBeUndefined();
    expect(config.apiSecurity).toBeUndefined();
    expect(config.database.poolMax).toBe(2);
  });

  it('rejects FUNDING_ENABLED=true because Phase 0 has no signing path', () => {
    expect(() =>
      loadConfig({ serviceRole: 'web', env: validWebEnv({ FUNDING_ENABLED: 'true' }) }),
    ).toThrow(ChainBankError);
  });

  it('rejects unsupported chain IDs including mainnet', () => {
    expect(() => loadConfig({ serviceRole: 'web', env: validWebEnv({ CHAIN_ID: '1' }) })).toThrow(
      ChainBankError,
    );
  });

  it('rejects an invalid treasury address', () => {
    expect(() =>
      loadConfig({ serviceRole: 'web', env: validWebEnv({ TREASURY_ADDRESS: 'not-an-address' }) }),
    ).toThrow(ChainBankError);
  });

  it('requires Resend credentials when EMAIL_PROVIDER=resend', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: undefined }),
      }),
    ).toThrow(ChainBankError);
  });

  it('rejects wildcard CORS in hosted environments', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({
          CHAINBANK_ENVIRONMENT: 'hosted-development',
          DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          CORS_ALLOWED_ORIGINS: '*',
        }),
      }),
    ).toThrow(ChainBankError);
  });

  it('accepts leading-dot fractional ETH strings from hosted env UIs', () => {
    const config = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({
        TREASURY_CRITICAL_BALANCE_ETH: '.25',
        TREASURY_MINIMUM_RESERVE_ETH: '.5',
      }),
    });
    expect(config.treasury.criticalBalanceWei).toBe(parseEtherToWei('0.25', 'c'));
    expect(config.treasury.minimumReserveWei).toBe(parseEtherToWei('0.5', 'r'));
  });

  it('requires DATABASE_SSL_CA when hosted database TLS is enabled', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'treasury-monitor',
        env: validMonitorEnv({
          CHAINBANK_ENVIRONMENT: 'hosted-development',
        }),
      }),
    ).toThrow(ChainBankError);

    const config = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({
        CHAINBANK_ENVIRONMENT: 'hosted-development',
        DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      }),
    });
    expect(config.database.useSsl).toBe(true);
    expect(config.database.sslCertificateAuthority).toContain('BEGIN CERTIFICATE');
  });
});
