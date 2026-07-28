import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { getTreasuryPrivateKey, loadConfig } from '../../../src/config/index.js';
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
    expect(config.isFundingKillSwitchActive).toBe(false);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
  });

  it('loads the treasury monitor without requiring email credentials', () => {
    const config = loadConfig({ serviceRole: 'treasury-monitor', env: validMonitorEnv() });

    expect(config.app.serviceRole).toBe('treasury-monitor');
    expect(config.email).toBeUndefined();
    expect(config.apiSecurity).toBeUndefined();
    expect(config.database.poolMax).toBe(2);
    expect(config.isFundingEnabled).toBe(false);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
  });

  it('rejects FUNDING_ENABLED=true for web without a treasury private key', () => {
    expect(() => loadConfig({ serviceRole: 'web', env: validWebEnv({ FUNDING_ENABLED: 'true' }) })).toThrow(
      ChainBankError,
    );

    try {
      loadConfig({ serviceRole: 'web', env: validWebEnv({ FUNDING_ENABLED: 'true' }) });
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).message).toMatch(/TREASURY_PRIVATE_KEY/);
      expect((error as ChainBankError).message).toMatch(/FUNDING_ENABLED=true/);
    }
  });

  it('rejects FUNDING_ENABLED=true with a malformed treasury private key', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({
          FUNDING_ENABLED: 'true',
          TREASURY_PRIVATE_KEY: 'not-a-key',
        }),
      }),
    ).toThrow(/malformed/i);
  });

  it('accepts FUNDING_ENABLED=true with a structurally valid disposable private key', () => {
    const privateKey = generatePrivateKey();
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: privateKey,
      }),
    });

    expect(config.isFundingEnabled).toBe(true);
    expect(getTreasuryPrivateKey(config)).toBe(privateKey);
    // Private key is non-enumerable; accidental JSON serialization must not leak it.
    expect(JSON.stringify(config.funding)).not.toContain(privateKey);
    expect(Object.keys(config.funding)).not.toContain('privateKey');
  });

  it('parses FUNDING_KILL_SWITCH without enabling funding', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ FUNDING_KILL_SWITCH: 'true' }),
    });
    expect(config.isFundingEnabled).toBe(false);
    expect(config.isFundingKillSwitchActive).toBe(true);
  });

  it('boots the treasury monitor without reading TREASURY_PRIVATE_KEY', () => {
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
    expect(JSON.stringify(config.funding)).not.toContain(privateKey);
    expect(Object.keys(config.funding)).not.toContain('privateKey');
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
