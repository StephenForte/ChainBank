import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import {
  getOperationalTreasuryPrivateKey,
  getTreasuryPrivateKey,
  loadConfig,
} from '../../../src/config/index.js';
import {
  findSupportedChainById,
  SUPPORTED_CHAINS,
  type SupportedChain,
} from '../../../src/config/supported-chains.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';
import { validMonitorEnv, validWebEnv } from '../../support/env.js';

describe('loadConfig', () => {
  it('loads a valid web configuration with integer-safe treasury thresholds', () => {
    const config = loadConfig({ serviceRole: 'web', env: validWebEnv() });

    expect(config.app.serviceRole).toBe('web');
    expect(config.chains).toHaveLength(1);
    expect(config.defaultChainId).toBe(11155111);
    expect(config.chain.chainId).toBe(11155111);
    expect(config.chains[0]?.chainId).toBe(11155111);
    expect(findSupportedChainById(config.chain.chainId)?.blockTimeMs).toBe(12_000);
    expect(SUPPORTED_CHAINS).toHaveLength(1);
    expect(config.treasury.warningBalanceWei).toBe(parseEtherToWei('1', 'w'));
    expect(config.email?.provider).toBe('log-only');
    expect(config.apiSecurity).toBeDefined();
    expect(config.isFundingEnabled).toBe(false);
    expect(config.isFundingKillSwitchActive).toBe(false);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
  });

  it('loads the treasury monitor with email credentials but no signing key', () => {
    const config = loadConfig({ serviceRole: 'treasury-monitor', env: validMonitorEnv() });

    expect(config.app.serviceRole).toBe('treasury-monitor');
    expect(config.email?.provider).toBe('log-only');
    expect(config.email?.operatorRecipients).toEqual(['operator@example.com']);
    expect(config.apiSecurity).toBeUndefined();
    expect(config.database.poolMax).toBe(2);
    expect(config.isFundingEnabled).toBe(false);
    expect(config.alerts.reminderIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
  });

  it('parses ALERT_REMINDER_INTERVAL_HOURS for monitor and web', () => {
    const monitor = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({ ALERT_REMINDER_INTERVAL_HOURS: '12' }),
    });
    expect(monitor.alerts.reminderIntervalMs).toBe(12 * 60 * 60 * 1000);

    const web = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ ALERT_REMINDER_INTERVAL_HOURS: '0' }),
    });
    expect(web.alerts.reminderIntervalMs).toBe(0);
  });

  it('defaults and parses RECONCILE_FAILURE_ALERT_THRESHOLD', () => {
    const defaults = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    expect(defaults.alerts.reconcileFailureAlertThreshold).toBe(3);

    const overridden = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ RECONCILE_FAILURE_ALERT_THRESHOLD: '5' }),
    });
    expect(overridden.alerts.reconcileFailureAlertThreshold).toBe(5);

    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({ RECONCILE_FAILURE_ALERT_THRESHOLD: '0' }),
      }),
    ).toThrow(ChainBankError);
  });

  it('loads optional FUNDING_HEALTH_TOKEN onto apiSecurity for web only', () => {
    const unset = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    expect(unset.apiSecurity?.fundingHealthToken).toBeUndefined();

    const set = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ FUNDING_HEALTH_TOKEN: 'consumer-shared-secret' }),
    });
    expect(set.apiSecurity?.fundingHealthToken).toBe('consumer-shared-secret');

    const monitor = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({ FUNDING_HEALTH_TOKEN: 'ignored-on-monitor' }),
    });
    expect(monitor.apiSecurity).toBeUndefined();
  });

  it('requires email credentials for the treasury monitor', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'treasury-monitor',
        env: validMonitorEnv({
          EMAIL_FROM_ADDRESS: undefined,
          EMAIL_OPERATOR_RECIPIENTS: undefined,
        }),
      }),
    ).toThrow(ChainBankError);
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

  it('defaults funding confirmation settings per D4', () => {
    const config = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    expect(config.funding.confirmations).toBe(1);
    expect(config.funding.confirmationTimeoutMs).toBe(60_000);
  });

  it('parses funding confirmation overrides', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        FUNDING_CONFIRMATIONS: '3',
        FUNDING_CONFIRMATION_TIMEOUT_MS: '120000',
      }),
    });
    expect(config.funding.confirmations).toBe(3);
    expect(config.funding.confirmationTimeoutMs).toBe(120_000);
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
        TREASURY_MINIMUM_RESERVE_ETH: '.1',
      }),
    });
    expect(config.treasury.criticalBalanceWei).toBe(parseEtherToWei('0.25', 'c'));
    expect(config.treasury.minimumReserveWei).toBe(parseEtherToWei('0.1', 'r'));
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

  it('rejects DATABASE_POOL_MAX < 2 for signing-capable roles (TX.10 dual-connection dispatch)', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({ DATABASE_POOL_MAX: '1' }),
      }),
    ).toThrow(/DATABASE_POOL_MAX must be at least 2/);

    expect(() =>
      loadConfig({
        serviceRole: 'cron-reconciler',
        env: validWebEnv({ DATABASE_POOL_MAX: '1' }),
      }),
    ).toThrow(/broadcast intent/);

    // Non-signing roles may keep a pool of 1 — they never enter funding dispatch.
    const monitor = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({ DATABASE_POOL_MAX: '1' }),
    });
    expect(monitor.database.poolMax).toBe(1);
  });

  const OPERATIONAL_ADDRESS = '0x0000000000000000000000000000000000000001';

  function twoTierVars(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      TREASURY_OPERATIONAL_ADDRESS: OPERATIONAL_ADDRESS,
      TREASURY_OPERATIONAL_WARNING_BALANCE_ETH: '0.2',
      TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH: '0.1',
      TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH: '0.4',
      TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH: '0.05',
      TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH: '0.15',
      TREASURY_OPERATIONAL_TARGET_BALANCE_ETH: '0.3',
      TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH: '0.2',
      ...overrides,
    };
  }

  it('stays in the single-treasury hatch when the operational address is unset or empty', () => {
    const unset = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    expect(unset.operationalTreasury).toBeUndefined();

    const empty = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ TREASURY_OPERATIONAL_ADDRESS: '' }),
    });
    expect(empty.operationalTreasury).toBeUndefined();
  });

  it('requires operational policy and threshold ETH when the operational address is set', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({ TREASURY_OPERATIONAL_ADDRESS: OPERATIONAL_ADDRESS }),
      }),
    ).toThrow(ChainBankError);
  });

  it('rejects an operational address that matches the public treasury', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv(
          twoTierVars({
            TREASURY_OPERATIONAL_ADDRESS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          }),
        ),
      }),
    ).toThrow(/must differ/);
  });

  it('loads two-tier operational config for web and requires the operational key when funding is armed', () => {
    const operationalKey = generatePrivateKey();
    const publicKey = generatePrivateKey();
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({
          ...twoTierVars(),
          FUNDING_ENABLED: 'true',
          TREASURY_PRIVATE_KEY: publicKey,
        }),
      }),
    ).toThrow(/TREASURY_OPERATIONAL_PRIVATE_KEY/);

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        ...twoTierVars(),
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: publicKey,
        TREASURY_OPERATIONAL_PRIVATE_KEY: operationalKey,
      }),
    });
    expect(config.operationalTreasury?.address.toLowerCase()).toBe(OPERATIONAL_ADDRESS);
    expect(getOperationalTreasuryPrivateKey(config)).toBe(operationalKey);
    expect(Object.keys(config.funding)).not.toContain('operationalPrivateKey');
  });

  it('strips both treasury keys from the treasury-monitor even when they are injected', () => {
    const publicKey = generatePrivateKey();
    const operationalKey = generatePrivateKey();
    const config = loadConfig({
      serviceRole: 'treasury-monitor',
      env: validMonitorEnv({
        ...twoTierVars(),
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: publicKey,
        TREASURY_OPERATIONAL_PRIVATE_KEY: operationalKey,
      }),
    });

    expect(config.isFundingEnabled).toBe(false);
    expect(getTreasuryPrivateKey(config)).toBeUndefined();
    expect(getOperationalTreasuryPrivateKey(config)).toBeUndefined();
    expect(JSON.stringify(config.funding)).not.toContain(publicKey);
    expect(JSON.stringify(config.funding)).not.toContain(operationalKey);
  });

  it('defaults TRUSTED_PROXY_CIDRS to private and loopback ranges', () => {
    const config = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    expect(config.apiSecurity?.trustedProxyCidrs).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '127.0.0.0/8',
      'fc00::/7',
    ]);
  });

  it('parses an explicit trusted-proxy allowlist as canonical CIDRs', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        TRUSTED_PROXY_CIDRS: '  203.0.113.5, 192.0.2.0/24 , fc00::1 ',
      }),
    });
    expect(config.apiSecurity?.trustedProxyCidrs).toEqual(['203.0.113.5/32', '192.0.2.0/24', 'fc00::1/128']);
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace'],
    [',', 'comma only'],
    ['10.0.0.0/8, nope', 'malformed address'],
    ['10.0.0.0/33', 'prefix past 32'],
    ['10.0.0.0/0', 'prefix 0'],
    ['fc00::/0', 'IPv6 prefix 0'],
    ['10.0.0.0/', 'missing prefix'],
  ])('rejects TRUSTED_PROXY_CIDRS %s (%s) with INVALID_CONFIGURATION', (value) => {
    expectInvalidConfiguration(validWebEnv({ TRUSTED_PROXY_CIDRS: value }));
  });

  it('rejects a malformed trusted-proxy list for roles that do not serve HTTP', () => {
    expectInvalidConfiguration(validMonitorEnv({ TRUSTED_PROXY_CIDRS: 'not-a-cidr' }), 'treasury-monitor');
  });

  it('loads the deployed singular env as exactly one chain with unchanged resolved fields', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        CHAIN_ID: '11155111',
        CHAIN_RPC_URL: 'https://rpc.example.test/sepolia',
        TREASURY_ADDRESS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        TREASURY_WARNING_BALANCE_ETH: '0.75',
        TREASURY_CRITICAL_BALANCE_ETH: '0.3',
        TREASURY_RECOVERY_BALANCE_ETH: '1.5',
        TREASURY_MINIMUM_RESERVE_ETH: '0.1',
        ...twoTierVars(),
      }),
    });

    expect(SUPPORTED_CHAINS).toHaveLength(1);
    expect(config.chains).toHaveLength(1);
    expect(config.defaultChainId).toBe(11155111);

    const chain = config.chains[0];
    expect(chain).toBeDefined();
    if (chain === undefined) {
      return;
    }

    expect(chain.slug).toBe('ethereum-sepolia');
    expect(chain.chainId).toBe(11155111);
    expect(chain.displayName).toBe('Ethereum Sepolia');
    expect(chain.nativeSymbol).toBe('ETH');
    expect(chain.rpcUrl).toBe('https://rpc.example.test/sepolia');
    expect(chain.explorerBaseUrl).toBe('https://sepolia.etherscan.io');
    expect(chain.treasury.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(chain.treasury.warningBalanceWei).toBe(parseEtherToWei('0.75', 'warning'));
    expect(chain.treasury.criticalBalanceWei).toBe(parseEtherToWei('0.3', 'critical'));
    expect(chain.treasury.recoveryBalanceWei).toBe(parseEtherToWei('1.5', 'recovery'));
    expect(chain.treasury.minimumReserveWei).toBe(parseEtherToWei('0.1', 'reserve'));

    const operational = chain.operationalTreasury;
    expect(operational).toBeDefined();
    if (operational === undefined) {
      return;
    }
    expect(operational.address).toBe('0x0000000000000000000000000000000000000001');
    expect(operational.warningBalanceWei).toBe(parseEtherToWei('0.2', 'op-warning'));
    expect(operational.criticalBalanceWei).toBe(parseEtherToWei('0.1', 'op-critical'));
    expect(operational.recoveryBalanceWei).toBe(parseEtherToWei('0.4', 'op-recovery'));
    expect(operational.minimumReserveWei).toBe(parseEtherToWei('0.05', 'op-reserve'));
    expect(operational.policy.minimumBalanceWei).toBe(parseEtherToWei('0.15', 'op-min'));
    expect(operational.policy.targetBalanceWei).toBe(parseEtherToWei('0.3', 'op-target'));
    expect(operational.policy.maximumTopUpWei).toBe(parseEtherToWei('0.2', 'op-max'));

    expect(config.chain.slug).toBe(chain.slug);
    expect(config.chain.chainId).toBe(chain.chainId);
    expect(config.chain.displayName).toBe(chain.displayName);
    expect(config.chain.nativeSymbol).toBe(chain.nativeSymbol);
    expect(config.chain.rpcUrl).toBe(chain.rpcUrl);
    expect(config.chain.explorerBaseUrl).toBe(chain.explorerBaseUrl);
    expect(config.treasury).toEqual(chain.treasury);
    expect(config.operationalTreasury).toEqual(chain.operationalTreasury);
  });

  it('rejects chain 84532 because SUPPORTED_CHAINS still has one row', () => {
    expect(SUPPORTED_CHAINS).toHaveLength(1);
    expect(() => loadConfig({ serviceRole: 'web', env: validWebEnv({ CHAIN_ID: '84532' }) })).toThrow(
      /84532/,
    );
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([{ ...sepoliaDocument(), chainId: 84532 }]),
      }),
    ).toThrow(/84532/);
  });

  it('loads two chains from CHAINS and points the default view at the first', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: chainsEnv([
        sepoliaDocument(),
        fixtureDocument({
          treasury: treasuryDocument('0x0000000000000000000000000000000000000002'),
        }),
      ]),
      supportedChains: [requireSepolia(), FIXTURE_CHAIN],
    });

    expect(config.chains).toHaveLength(2);
    expect(config.chains.map((chain) => chain.chainId)).toEqual([11155111, 424242]);
    expect(config.chains[0]?.rpcUrl).toBe('https://rpc.example.test/sepolia');
    expect(config.chains[1]?.rpcUrl).toBe('https://rpc.example.test/fixture');
    expect(config.defaultChainId).toBe(11155111);
    expect(config.chain.chainId).toBe(11155111);
    expect(config.treasury.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(config.chains[1]?.treasury.address).toBe('0x0000000000000000000000000000000000000002');
    expect(config.treasury.address).not.toBe(config.chains[1]?.treasury.address);
  });

  it('rejects a mixed hatch and two-tier chain list at load and names both chains', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([
          { ...sepoliaDocument(), operationalTreasury: operationalDocument(OPERATIONAL_ADDRESS) },
          fixtureDocument(),
        ]),
        supportedChains: [requireSepolia(), FIXTURE_CHAIN],
      }),
    ).toThrow(
      /ethereum-sepolia \(11155111\).*fixture-chain \(424242\)|fixture-chain \(424242\).*ethereum-sepolia \(11155111\)/,
    );
  });

  it('rejects an empty chain list, a duplicate chain id, a missing RPC URL, and an operational address without amounts', () => {
    expect(() => loadConfig({ serviceRole: 'web', env: chainsEnv([]) })).toThrow(/empty/i);

    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([
          sepoliaDocument(),
          { ...sepoliaDocument(), rpcUrl: 'https://rpc.example.test/other' },
        ]),
      }),
    ).toThrow(/11155111 is configured more than once/);

    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([{ ...sepoliaDocument(), rpcUrl: undefined }]),
      }),
    ).toThrow(/rpcUrl/);

    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([
          {
            ...sepoliaDocument(),
            operationalTreasury: { address: OPERATIONAL_ADDRESS },
          },
        ]),
      }),
    ).toThrow(/operationalTreasury\.warningBalanceEth|warningBalanceEth/);
  });

  it('rejects CHAINS combined with the singular form and names the conflicting variables', () => {
    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: validWebEnv({ CHAINS: JSON.stringify([sepoliaDocument()]) }),
      }),
    ).toThrow(/CHAINS cannot be combined with the singular chain configuration \(CHAIN_ID,/);

    const onlyTreasury = chainsEnv([sepoliaDocument()], {
      TREASURY_ADDRESS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    });
    expect(() => loadConfig({ serviceRole: 'web', env: onlyTreasury })).toThrow(
      /CHAINS cannot be combined with the singular chain configuration \(TREASURY_ADDRESS\)/,
    );
  });

  it('treats a blank CHAINS value as unset and keeps the singular form', () => {
    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ CHAINS: '   ' }),
    });
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0]?.chainId).toBe(11155111);
  });

  it('rejects a private key and a floating-point amount inside CHAINS', () => {
    const privateKey = generatePrivateKey();
    try {
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([{ ...sepoliaDocument(), privateKey }]),
      });
      expect.fail('expected INVALID_CONFIGURATION');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INVALID_CONFIGURATION');
      expect((error as ChainBankError).message).toMatch(/privateKey/);
      expect((error as ChainBankError).message).not.toContain(privateKey);
    }

    expect(() =>
      loadConfig({
        serviceRole: 'web',
        env: chainsEnv([
          {
            ...sepoliaDocument(),
            treasury: { ...treasuryDocument(PUBLIC_ADDRESS), warningBalanceEth: 0.75 },
          },
        ]),
      }),
    ).toThrow(/warningBalanceEth/);
  });
});

const PUBLIC_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const FIXTURE_CHAIN: SupportedChain = {
  slug: 'fixture-chain',
  chainId: 424242,
  displayName: 'Fixture Chain',
  nativeSymbol: 'ETH',
  defaultExplorerBaseUrl: 'https://fixture.example',
  blockTimeMs: 2_000,
};

const SINGULAR_KEYS_IN_FIXTURE = [
  'CHAIN_ID',
  'CHAIN_RPC_URL',
  'TREASURY_ADDRESS',
  'TREASURY_WARNING_BALANCE_ETH',
  'TREASURY_CRITICAL_BALANCE_ETH',
  'TREASURY_RECOVERY_BALANCE_ETH',
  'TREASURY_MINIMUM_RESERVE_ETH',
] as const;

function requireSepolia(): SupportedChain {
  const chain = SUPPORTED_CHAINS[0];
  if (chain === undefined) {
    throw new Error('SUPPORTED_CHAINS is empty');
  }
  return chain;
}

function treasuryDocument(address: string): {
  readonly address: string;
  readonly warningBalanceEth: string;
  readonly criticalBalanceEth: string;
  readonly recoveryBalanceEth: string;
  readonly minimumReserveEth: string;
} {
  return {
    address,
    warningBalanceEth: '0.75',
    criticalBalanceEth: '0.3',
    recoveryBalanceEth: '1.5',
    minimumReserveEth: '0.1',
  };
}

function operationalDocument(address: string): {
  readonly address: string;
  readonly warningBalanceEth: string;
  readonly criticalBalanceEth: string;
  readonly recoveryBalanceEth: string;
  readonly minimumReserveEth: string;
  readonly minimumBalanceEth: string;
  readonly targetBalanceEth: string;
  readonly maximumTopUpEth: string;
} {
  return {
    address,
    warningBalanceEth: '0.2',
    criticalBalanceEth: '0.1',
    recoveryBalanceEth: '0.4',
    minimumReserveEth: '0.05',
    minimumBalanceEth: '0.15',
    targetBalanceEth: '0.3',
    maximumTopUpEth: '0.2',
  };
}

function sepoliaDocument(): {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly treasury: ReturnType<typeof treasuryDocument>;
} {
  return {
    chainId: 11155111,
    rpcUrl: 'https://rpc.example.test/sepolia',
    treasury: treasuryDocument(PUBLIC_ADDRESS),
  };
}

function fixtureDocument(overrides: { readonly treasury?: ReturnType<typeof treasuryDocument> } = {}): {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly treasury: ReturnType<typeof treasuryDocument>;
} {
  return {
    chainId: FIXTURE_CHAIN.chainId,
    rpcUrl: 'https://rpc.example.test/fixture',
    treasury: overrides.treasury ?? treasuryDocument('0x0000000000000000000000000000000000000002'),
  };
}

function chainsEnv(
  documents: readonly unknown[],
  extras: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = validWebEnv();
  for (const key of SINGULAR_KEYS_IN_FIXTURE) {
    delete env[key];
  }
  return { ...env, CHAINS: JSON.stringify(documents), ...extras };
}

function expectInvalidConfiguration(
  env: ReturnType<typeof validWebEnv>,
  serviceRole: 'web' | 'treasury-monitor' = 'web',
): void {
  try {
    loadConfig({ serviceRole, env });
    expect.fail('expected INVALID_CONFIGURATION');
  } catch (error) {
    expect(error).toBeInstanceOf(ChainBankError);
    expect((error as ChainBankError).code).toBe('INVALID_CONFIGURATION');
  }
}
