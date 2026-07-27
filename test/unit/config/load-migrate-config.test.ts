import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import { loadMigrateConfig } from '../../../src/config/load-migrate-config.js';

describe('loadMigrateConfig', () => {
  it('requires only DATABASE_URL and ignores treasury threshold vars', () => {
    const config = loadMigrateConfig({
      DATABASE_URL: 'postgres://localhost:5432/chainbank',
      CHAINBANK_ENVIRONMENT: 'hosted-development',
      // Intentionally invalid for the full app config — migrate must not care.
      TREASURY_CRITICAL_BALANCE_ETH: 'not-a-number',
      TREASURY_MINIMUM_RESERVE_ETH: '',
    });

    expect(config.database.url).toBe('postgres://localhost:5432/chainbank');
    expect(config.database.poolMax).toBe(1);
    expect(config.database.useSsl).toBe(true);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadMigrateConfig({})).toThrow(ChainBankError);
  });
});
