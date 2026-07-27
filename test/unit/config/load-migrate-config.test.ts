import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import { loadMigrateConfig } from '../../../src/config/load-migrate-config.js';

const SAMPLE_CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('loadMigrateConfig', () => {
  it('requires only database settings and ignores treasury threshold vars', () => {
    const config = loadMigrateConfig({
      DATABASE_URL: 'postgres://localhost:5432/chainbank',
      CHAINBANK_ENVIRONMENT: 'local',
      // Intentionally invalid for the full app config — migrate must not care.
      TREASURY_CRITICAL_BALANCE_ETH: 'not-a-number',
      TREASURY_MINIMUM_RESERVE_ETH: '',
    });

    expect(config.database.url).toBe('postgres://localhost:5432/chainbank');
    expect(config.database.poolMax).toBe(1);
    expect(config.database.useSsl).toBe(false);
  });

  it('requires DATABASE_SSL_CA when hosted TLS is enabled', () => {
    expect(() =>
      loadMigrateConfig({
        DATABASE_URL: 'postgres://localhost:5432/chainbank',
        CHAINBANK_ENVIRONMENT: 'hosted-development',
      }),
    ).toThrow(ChainBankError);

    const config = loadMigrateConfig({
      DATABASE_URL: 'postgres://localhost:5432/chainbank',
      CHAINBANK_ENVIRONMENT: 'hosted-development',
      DATABASE_SSL_CA: SAMPLE_CA,
    });
    expect(config.database.useSsl).toBe(true);
    expect(config.database.sslCertificateAuthority).toBe(SAMPLE_CA);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadMigrateConfig({})).toThrow(ChainBankError);
  });
});
