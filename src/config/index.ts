import { getAddress, isAddress, isHex } from 'viem';
import { ChainBankError } from '../domain/errors.js';
import { validatePolicy } from '../domain/funding/funding-math.js';
import { assertValidTreasuryThresholds } from '../domain/treasury/treasury-status.js';
import { parseEtherToWei } from '../domain/wei.js';
import {
  chainDocumentSchema,
  environmentSchema,
  REQUIRED_SINGULAR_CHAIN_ENV_KEYS,
  SINGULAR_CHAIN_ENV_KEYS,
  type ChainDocument,
  type RawEnvironment,
} from './schema.js';
import { SUPPORTED_CHAINS, type SupportedChain } from './supported-chains.js';
import { parseTrustedProxyCidrs } from './trusted-proxy.js';

/**
 * Which process is booting. The role decides which configuration sections are
 * mandatory, so a read-only monitor is never handed credentials it must not
 * hold and never fails to start over a section it does not use.
 */
export type ServiceRole = 'web' | 'treasury-monitor' | 'cron-reconciler';

/**
 * Roles that may construct a TreasurySigner and receive the signing secret.
 * `treasury-monitor` is intentionally excluded and always strips the key.
 */
export function isSigningCapableRole(serviceRole: ServiceRole): boolean {
  return serviceRole === 'web' || serviceRole === 'cron-reconciler';
}

export interface AppConfig {
  readonly nodeEnv: RawEnvironment['NODE_ENV'];
  readonly environment: RawEnvironment['CHAINBANK_ENVIRONMENT'];
  readonly serviceRole: ServiceRole;
  readonly logLevel: RawEnvironment['LOG_LEVEL'];
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly isHosted: boolean;
}

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly useSsl: boolean;
  readonly sslCertificateAuthority: string | undefined;
}

export interface ChainConfig {
  readonly slug: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
  readonly rpcUrl: string;
  readonly explorerBaseUrl: string;
}

/**
 * One configured chain plus the treasury rows that chain funds from.
 * Identity fields match {@link ChainConfig}. Treasury amounts are per chain.
 */
export interface ConfiguredChain extends ChainConfig {
  readonly treasury: TreasuryConfig;
  readonly operationalTreasury: OperationalTreasuryConfig | undefined;
}

export interface TreasuryConfig {
  readonly address: `0x${string}`;
  readonly warningBalanceWei: bigint;
  readonly criticalBalanceWei: bigint;
  readonly recoveryBalanceWei: bigint;
  readonly minimumReserveWei: bigint;
}

export interface OperationalTreasuryPolicyConfig {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
}

export interface OperationalTreasuryConfig {
  readonly address: `0x${string}`;
  readonly warningBalanceWei: bigint;
  readonly criticalBalanceWei: bigint;
  readonly recoveryBalanceWei: bigint;
  readonly minimumReserveWei: bigint;
  readonly policy: OperationalTreasuryPolicyConfig;
}

export type EmailConfig =
  | {
      readonly provider: 'resend';
      readonly apiKey: string;
      readonly fromAddress: string;
      readonly operatorRecipients: readonly string[];
    }
  | {
      readonly provider: 'log-only';
      readonly fromAddress: string;
      readonly operatorRecipients: readonly string[];
    };

export interface ApiSecurityConfig {
  readonly corsAllowedOrigins: readonly string[];
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
  /** Canonical `address/prefix` entries. X-Forwarded-* is honoured only for a peer in this set. */
  readonly trustedProxyCidrs: readonly string[];
  /**
   * Static bearer for GET /health/funding. Undefined when FUNDING_HEALTH_TOKEN
   * is unset — the route then fails closed (401) rather than exposing inventory.
   */
  readonly fundingHealthToken: string | undefined;
}

export interface FundingConfig {
  readonly enabled: boolean;
  readonly killSwitch: boolean;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  /**
   * Present only for signing-capable roles with a structurally valid key.
   * Never enumerable on the returned config object so accidental JSON
   * serialization cannot leak it.
   */
  readonly privateKey: `0x${string}` | undefined;
  /**
   * Operational-treasury key. Present only for signing-capable roles in
   * two-tier mode. Non-enumerable; use {@link getOperationalTreasuryPrivateKey}.
   */
  readonly operationalPrivateKey: `0x${string}` | undefined;
}

export interface AlertsConfig {
  /** Reminder interval derived from ALERT_REMINDER_INTERVAL_HOURS. */
  readonly reminderIntervalMs: number;
  /**
   * Consecutive failed reconciliation runs before opening a critical alert
   * (RECONCILE_FAILURE_ALERT_THRESHOLD; C15 / P4-US3).
   */
  readonly reconcileFailureAlertThreshold: number;
}

export interface ReconciliationConfig {
  /** Lookback bound for outgoing scans (C14). Passed to reconcileWallets as bigint. */
  readonly outgoingLookbackBlocks: number;
}

export interface ChainBankConfig {
  readonly app: AppConfig;
  readonly database: DatabaseConfig;
  /**
   * Every chain this process serves. One entry for the singular env form.
   * Adapters, treasury registration, and heartbeats walk this list.
   */
  readonly chains: readonly ConfiguredChain[];
  /**
   * Chain described by the singular `chain` / `treasury` / `operationalTreasury`
   * views. The singular env has one chain, so this is that chain. A `CHAINS`
   * document uses its first element. Callers that must cover every chain read
   * `chains`, not this id.
   */
  readonly defaultChainId: number;
  /** Default chain identity. Equal to `chains` for that `defaultChainId`. */
  readonly chain: ChainConfig;
  /** External treasury of the default chain. */
  readonly treasury: TreasuryConfig;
  /**
   * Operational treasury of the default chain. Present when that chain is
   * two-tier. D16 requires every chain to match this mode.
   */
  readonly operationalTreasury: OperationalTreasuryConfig | undefined;
  /**
   * Present for web, treasury-monitor, and cron-reconciler; absent for roles
   * that never send mail.
   */
  readonly email: EmailConfig | undefined;
  /** Absent for non-API roles. */
  readonly apiSecurity: ApiSecurityConfig | undefined;
  readonly alerts: AlertsConfig;
  /** Present for cron-reconciler; absent for roles that do not reconcile. */
  readonly reconciliation: ReconciliationConfig | undefined;
  readonly isFundingEnabled: boolean;
  readonly isFundingKillSwitchActive: boolean;
  /**
   * Signing material for signing-capable roles only. The private key is stored
   * non-enumerably; prefer {@link getTreasuryPrivateKey} over walking this object.
   */
  readonly funding: FundingConfig;
}

/**
 * Default pool ceilings. A short-lived cron needs far fewer connections than the API.
 *
 * Signing-capable roles require at least 2 (see {@link assertSigningPoolCapacity}):
 * TX.10 commits the broadcast intent on a second connection while the advisory-lock
 * transaction holds the first. `cron-reconciler` defaults to 3 so one in-lock DB call
 * beyond today's path still has headroom.
 */
const DEFAULT_POOL_MAX: Readonly<Record<ServiceRole, number>> = {
  web: 10,
  'treasury-monitor': 2,
  'cron-reconciler': 3,
};

/** Minimum pool size for roles that may enter funding dispatch (TX.10). */
const SIGNING_ROLE_MIN_POOL_MAX = 2;

export interface LoadConfigOptions {
  readonly serviceRole: ServiceRole;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Chain ids this load may accept. Production entry points omit it and get
   * {@link SUPPORTED_CHAINS}. Tests pass a wider catalog to exercise N-chain
   * rules before a second chain is registered; a deployed process that omits
   * this still rejects every id outside that list.
   */
  readonly supportedChains?: readonly SupportedChain[];
}

/**
 * Validates the environment and fails fast with every problem listed at once,
 * so a misconfigured deploy is fixed in one pass rather than one variable per
 * restart.
 */
export function loadConfig(options: LoadConfigOptions): ChainBankConfig {
  const source = options.env ?? process.env;
  // Strip signing material before parse for non-signing roles so the monitor
  // never observes TREASURY_PRIVATE_KEY, even when a shared env injects it.
  const envSource = isSigningCapableRole(options.serviceRole) ? source : omitSigningKeys(source);
  const parsed = environmentSchema.safeParse(envSource);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ChainBankError('INVALID_CONFIGURATION', `Invalid environment configuration:\n${details}`, {
      publicMessage: 'The service is misconfigured.',
    });
  }

  const env = parsed.data;
  const isHosted = env.CHAINBANK_ENVIRONMENT !== 'local';
  // Parsed for every role. A malformed allowlist must fail the process that
  // loaded it, including roles that never honour X-Forwarded-*.
  const trustedProxyCidrs = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
  const chains = buildConfiguredChains(env, options.supportedChains ?? SUPPORTED_CHAINS);
  const defaultChain = chains[0];
  const funding = buildFundingConfig(
    env,
    options.serviceRole,
    defaultChain.operationalTreasury !== undefined,
  );

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      environment: env.CHAINBANK_ENVIRONMENT,
      serviceRole: options.serviceRole,
      logLevel: env.LOG_LEVEL,
      port: env.PORT,
      host: env.HOST,
      publicBaseUrl: stripTrailingSlash(env.PUBLIC_BASE_URL),
      isHosted,
    },
    database: buildDatabaseConfig(env, options.serviceRole, isHosted),
    chains,
    defaultChainId: defaultChain.chainId,
    chain: {
      slug: defaultChain.slug,
      chainId: defaultChain.chainId,
      displayName: defaultChain.displayName,
      nativeSymbol: defaultChain.nativeSymbol,
      rpcUrl: defaultChain.rpcUrl,
      explorerBaseUrl: defaultChain.explorerBaseUrl,
    },
    treasury: defaultChain.treasury,
    operationalTreasury: defaultChain.operationalTreasury,
    email: requiresEmailConfig(options.serviceRole) ? buildEmailConfig(env, options.serviceRole) : undefined,
    apiSecurity:
      options.serviceRole === 'web' ? buildApiSecurityConfig(env, isHosted, trustedProxyCidrs) : undefined,
    alerts: {
      reminderIntervalMs: env.ALERT_REMINDER_INTERVAL_HOURS * 60 * 60 * 1000,
      reconcileFailureAlertThreshold: env.RECONCILE_FAILURE_ALERT_THRESHOLD,
    },
    reconciliation:
      options.serviceRole === 'cron-reconciler'
        ? { outgoingLookbackBlocks: env.RECONCILE_OUTGOING_LOOKBACK_BLOCKS }
        : undefined,
    isFundingEnabled: funding.enabled,
    isFundingKillSwitchActive: funding.killSwitch,
    funding,
  };
}

function omitSigningKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy.TREASURY_PRIVATE_KEY;
  delete copy.TREASURY_OPERATIONAL_PRIVATE_KEY;
  return copy;
}

function requiresEmailConfig(serviceRole: ServiceRole): boolean {
  return serviceRole === 'web' || serviceRole === 'treasury-monitor' || serviceRole === 'cron-reconciler';
}

/**
 * Returns the treasury private key for a signing-capable config, if present.
 * Prefer this over reading `config.funding.privateKey` so call sites stay explicit.
 */
export function getTreasuryPrivateKey(config: ChainBankConfig): `0x${string}` | undefined {
  return config.funding.privateKey;
}

export function getOperationalTreasuryPrivateKey(config: ChainBankConfig): `0x${string}` | undefined {
  return config.funding.operationalPrivateKey;
}

function buildFundingConfig(
  env: RawEnvironment,
  serviceRole: ServiceRole,
  isTwoTier: boolean,
): FundingConfig {
  const killSwitch = env.FUNDING_KILL_SWITCH;
  const confirmations = env.FUNDING_CONFIRMATIONS;
  const confirmationTimeoutMs = env.FUNDING_CONFIRMATION_TIMEOUT_MS;

  // The monitor must never read or require the signing key, even when a shared
  // hosted environment sets FUNDING_ENABLED=true for sibling services.
  if (!isSigningCapableRole(serviceRole)) {
    return createFundingConfig({
      enabled: false,
      killSwitch,
      confirmations,
      confirmationTimeoutMs,
      privateKey: undefined,
      operationalPrivateKey: undefined,
    });
  }

  const rawKey = env.TREASURY_PRIVATE_KEY;
  const privateKey =
    rawKey === undefined
      ? undefined
      : parseTreasuryPrivateKey(rawKey, env.FUNDING_ENABLED, 'TREASURY_PRIVATE_KEY');

  if (env.FUNDING_ENABLED && privateKey === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'FUNDING_ENABLED=true requires a structurally valid TREASURY_PRIVATE_KEY ' +
        'for this signing-capable service role. Provide a 32-byte hex private key ' +
        '(0x-prefixed, 64 hex digits), or set FUNDING_ENABLED=false.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const rawOperationalKey = env.TREASURY_OPERATIONAL_PRIVATE_KEY;
  const operationalPrivateKey =
    rawOperationalKey === undefined
      ? undefined
      : parseTreasuryPrivateKey(rawOperationalKey, env.FUNDING_ENABLED, 'TREASURY_OPERATIONAL_PRIVATE_KEY');

  if (env.FUNDING_ENABLED && isTwoTier && operationalPrivateKey === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'FUNDING_ENABLED=true with an operational treasury configured requires a structurally valid ' +
        'TREASURY_OPERATIONAL_PRIVATE_KEY for this signing-capable service role.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return createFundingConfig({
    enabled: env.FUNDING_ENABLED,
    killSwitch,
    confirmations,
    confirmationTimeoutMs,
    privateKey,
    operationalPrivateKey,
  });
}

function createFundingConfig(input: {
  readonly enabled: boolean;
  readonly killSwitch: boolean;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  readonly privateKey: `0x${string}` | undefined;
  readonly operationalPrivateKey: `0x${string}` | undefined;
}): FundingConfig {
  // Keep signing keys non-enumerable so JSON.stringify(config) cannot leak them.
  const funding = {
    enabled: input.enabled,
    killSwitch: input.killSwitch,
    confirmations: input.confirmations,
    confirmationTimeoutMs: input.confirmationTimeoutMs,
  } as FundingConfig;
  Object.defineProperty(funding, 'privateKey', {
    value: input.privateKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(funding, 'operationalPrivateKey', {
    value: input.operationalPrivateKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return funding;
}

/**
 * Structurally validates a treasury private key.
 *
 * When funding is enabled, any absent/malformed value is a hard startup failure.
 * When funding is disabled, a present-but-malformed value still fails closed so
 * a bad secret cannot sit unnoticed until the operator flips the gate.
 */
function parseTreasuryPrivateKey(
  rawKey: string,
  isFundingEnabled: boolean,
  envName: 'TREASURY_PRIVATE_KEY' | 'TREASURY_OPERATIONAL_PRIVATE_KEY',
): `0x${string}` | undefined {
  if (!isStructurallyValidPrivateKey(rawKey)) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      isFundingEnabled
        ? `FUNDING_ENABLED=true but ${envName} is malformed. ` +
            'Expected a 0x-prefixed 32-byte hex private key (64 hex digits). ' +
            'Fix or remove the key, or set FUNDING_ENABLED=false.'
        : `${envName} is present but malformed. ` +
            'Expected a 0x-prefixed 32-byte hex private key (64 hex digits). ' +
            'Fix or remove the key before enabling funding.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }
  return rawKey;
}

function isStructurallyValidPrivateKey(value: string): value is `0x${string}` {
  return isHex(value, { strict: true }) && value.length === 66;
}

function buildDatabaseConfig(
  env: RawEnvironment,
  serviceRole: ServiceRole,
  isHosted: boolean,
): DatabaseConfig {
  const useSsl = env.DATABASE_SSL ?? isHosted;
  const sslCertificateAuthority = env.DATABASE_SSL_CA;

  if (useSsl && (sslCertificateAuthority === undefined || sslCertificateAuthority.trim() === '')) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'DATABASE_SSL_CA is required when database TLS is enabled. ' +
        'Never disable certificate verification; provide the provider CA PEM instead.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const poolMax = env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX[serviceRole];
  assertSigningPoolCapacity(serviceRole, poolMax);

  return {
    url: env.DATABASE_URL,
    poolMax,
    useSsl,
    sslCertificateAuthority,
  };
}

/**
 * Signing-capable roles must keep two pooled connections available for funding
 * dispatch: the advisory-lock transaction holds one while TX.10 commits the
 * broadcast intent on a second.
 *
 * With `poolMax: 1` the intent insert waits for a connection that cannot be
 * freed until the lock transaction ends, so every dispatch stalls for
 * `connectionTimeoutMillis` (10s) — holding `pg_advisory_xact_lock` the whole
 * time — and then fails closed with `DATABASE_UNAVAILABLE` before any
 * broadcast. Measured: one dispatch rejected at ~10.0s with zero sends.
 * This guard turns that per-request runtime stall into a startup failure.
 */
function assertSigningPoolCapacity(serviceRole: ServiceRole, poolMax: number): void {
  if (!isSigningCapableRole(serviceRole)) {
    return;
  }
  if (poolMax < SIGNING_ROLE_MIN_POOL_MAX) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `DATABASE_POOL_MAX must be at least ${String(SIGNING_ROLE_MIN_POOL_MAX)} for the ` +
        `${serviceRole} service. TX.10 commits the funding broadcast intent on a second ` +
        'pool connection while the advisory-lock transaction holds the first; with a pool ' +
        'of 1 every funding dispatch stalls for the 10s connection timeout while holding ' +
        'the treasury advisory lock, then fails with DATABASE_UNAVAILABLE before broadcast.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }
}

/**
 * Resolves `config.chains`. The singular env variables and the `CHAINS`
 * document are mutually exclusive: both present is a startup error, not a
 * precedence. An empty list, an unknown chain id, a duplicate chain id, a
 * missing RPC URL, or a mixed hatch/two-tier set (D16) fails closed.
 */
function buildConfiguredChains(
  env: RawEnvironment,
  catalog: readonly SupportedChain[],
): readonly [ConfiguredChain, ...ConfiguredChain[]] {
  const chainsDocument = env.CHAINS;
  const singularPresent = SINGULAR_CHAIN_ENV_KEYS.filter((key) => env[key] !== undefined);

  if (chainsDocument !== undefined && singularPresent.length > 0) {
    throw invalidConfiguration(
      `CHAINS cannot be combined with the singular chain configuration (${singularPresent.join(', ')}). ` +
        'Remove one form. The two are mutually exclusive so a deploy cannot silently prefer whichever was parsed last.',
    );
  }

  const chains =
    chainsDocument === undefined
      ? [configuredChainFromSingular(env, catalog)]
      : configuredChainsFromDocument(chainsDocument, catalog);

  return assertChainList(chains);
}

function configuredChainFromSingular(
  env: RawEnvironment,
  catalog: readonly SupportedChain[],
): ConfiguredChain {
  const missing = REQUIRED_SINGULAR_CHAIN_ENV_KEYS.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw invalidConfiguration(
      `Singular chain configuration is incomplete. Missing: ${missing.join(', ')}. ` +
        'Set these, or set CHAINS and omit the singular chain variables.',
    );
  }

  const chainId = requirePresent(env.CHAIN_ID, 'CHAIN_ID');
  const rpcUrl = requirePresent(env.CHAIN_RPC_URL, 'CHAIN_RPC_URL');
  const treasuryAddress = requirePresent(env.TREASURY_ADDRESS, 'TREASURY_ADDRESS');
  const supported = requireSupportedChain(chainId, catalog, `CHAIN_ID ${String(chainId)}`);
  const externalAddress = parseConfiguredAddress(treasuryAddress, 'TREASURY_ADDRESS');

  return toConfiguredChain({
    supported,
    rpcUrl,
    explorerBaseUrl: env.CHAIN_EXPLORER_BASE_URL,
    treasury: {
      address: externalAddress,
      ...treasuryThresholdsFromEth(
        {
          warningBalanceEth: requirePresent(env.TREASURY_WARNING_BALANCE_ETH, 'TREASURY_WARNING_BALANCE_ETH'),
          criticalBalanceEth: requirePresent(
            env.TREASURY_CRITICAL_BALANCE_ETH,
            'TREASURY_CRITICAL_BALANCE_ETH',
          ),
          recoveryBalanceEth: requirePresent(
            env.TREASURY_RECOVERY_BALANCE_ETH,
            'TREASURY_RECOVERY_BALANCE_ETH',
          ),
          minimumReserveEth: requirePresent(env.TREASURY_MINIMUM_RESERVE_ETH, 'TREASURY_MINIMUM_RESERVE_ETH'),
        },
        {
          warning: 'TREASURY_WARNING_BALANCE_ETH',
          critical: 'TREASURY_CRITICAL_BALANCE_ETH',
          recovery: 'TREASURY_RECOVERY_BALANCE_ETH',
          reserve: 'TREASURY_MINIMUM_RESERVE_ETH',
        },
      ),
    },
    operationalTreasury: buildOperationalTreasury({
      rawAddress: env.TREASURY_OPERATIONAL_ADDRESS,
      externalAddress,
      addressLabel: 'TREASURY_OPERATIONAL_ADDRESS',
      differLabel: 'TREASURY_OPERATIONAL_ADDRESS must differ from TREASURY_ADDRESS',
      amounts: {
        warningBalanceEth: env.TREASURY_OPERATIONAL_WARNING_BALANCE_ETH,
        criticalBalanceEth: env.TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH,
        recoveryBalanceEth: env.TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH,
        minimumReserveEth: env.TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH,
        minimumBalanceEth: env.TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH,
        targetBalanceEth: env.TREASURY_OPERATIONAL_TARGET_BALANCE_ETH,
        maximumTopUpEth: env.TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH,
      },
      amountLabels: {
        warning: 'TREASURY_OPERATIONAL_WARNING_BALANCE_ETH',
        critical: 'TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH',
        recovery: 'TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH',
        reserve: 'TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH',
        minimum: 'TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH',
        target: 'TREASURY_OPERATIONAL_TARGET_BALANCE_ETH',
        maximum: 'TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH',
      },
    }),
  });
}

function configuredChainsFromDocument(
  raw: string,
  catalog: readonly SupportedChain[],
): readonly ConfiguredChain[] {
  const entries = readChainsDocument(raw);
  return entries.map((entry) => {
    const supported = requireSupportedChain(entry.chainId, catalog, `Chain id ${String(entry.chainId)}`);
    const chainLabel = `${supported.slug} (${String(supported.chainId)})`;
    const externalAddress = parseConfiguredAddress(
      entry.treasury.address,
      `treasury address on ${chainLabel}`,
    );
    const operational = entry.operationalTreasury;

    return toConfiguredChain({
      supported,
      rpcUrl: entry.rpcUrl,
      explorerBaseUrl: entry.explorerBaseUrl,
      treasury: {
        address: externalAddress,
        ...treasuryThresholdsFromEth(entry.treasury, {
          warning: `warningBalanceEth on ${chainLabel}`,
          critical: `criticalBalanceEth on ${chainLabel}`,
          recovery: `recoveryBalanceEth on ${chainLabel}`,
          reserve: `minimumReserveEth on ${chainLabel}`,
        }),
      },
      operationalTreasury:
        operational === undefined
          ? undefined
          : buildOperationalTreasury({
              rawAddress: operational.address,
              externalAddress,
              addressLabel: `operational treasury address on ${chainLabel}`,
              differLabel: `Operational treasury address must differ from the external treasury address on ${chainLabel}`,
              amounts: operational,
              amountLabels: {
                warning: `operationalTreasury.warningBalanceEth on ${chainLabel}`,
                critical: `operationalTreasury.criticalBalanceEth on ${chainLabel}`,
                recovery: `operationalTreasury.recoveryBalanceEth on ${chainLabel}`,
                reserve: `operationalTreasury.minimumReserveEth on ${chainLabel}`,
                minimum: `operationalTreasury.minimumBalanceEth on ${chainLabel}`,
                target: `operationalTreasury.targetBalanceEth on ${chainLabel}`,
                maximum: `operationalTreasury.maximumTopUpEth on ${chainLabel}`,
              },
            }),
    });
  });
}

function readChainsDocument(raw: string): readonly ChainDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidConfiguration('CHAINS is not valid JSON. Expected a JSON array of chain objects.');
  }

  if (!Array.isArray(parsed)) {
    throw invalidConfiguration('CHAINS must be a JSON array of chain objects.');
  }
  if (parsed.length === 0) {
    throw invalidConfiguration('CHAINS is empty. At least one chain is required.');
  }

  return parsed.map((entry, index) => {
    const result = chainDocumentSchema.safeParse(entry);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw invalidConfiguration(
        `CHAINS[${String(index)}] (${chainDocumentLabel(entry, index)}) is invalid: ${details}`,
      );
    }
    return result.data;
  });
}

function chainDocumentLabel(entry: unknown, index: number): string {
  if (typeof entry !== 'object' || entry === null || !('chainId' in entry)) {
    return `index ${String(index)}`;
  }
  const chainId = entry.chainId;
  if (typeof chainId === 'number' && Number.isSafeInteger(chainId)) {
    return `chain ${String(chainId)}`;
  }
  return `index ${String(index)}`;
}

function assertChainList(
  chains: readonly ConfiguredChain[],
): readonly [ConfiguredChain, ...ConfiguredChain[]] {
  const first = chains[0];
  if (first === undefined) {
    throw invalidConfiguration('No chains are configured. At least one chain is required.');
  }

  const seen = new Set<number>();
  for (const chain of chains) {
    if (seen.has(chain.chainId)) {
      throw invalidConfiguration(`Chain id ${String(chain.chainId)} is configured more than once.`);
    }
    seen.add(chain.chainId);
  }

  const twoTier = chains.filter((chain) => chain.operationalTreasury !== undefined);
  const hatch = chains.filter((chain) => chain.operationalTreasury === undefined);
  if (twoTier.length > 0 && hatch.length > 0) {
    const format = (chain: ConfiguredChain): string => `${chain.slug} (${String(chain.chainId)})`;
    throw invalidConfiguration(
      `Treasury mode is process-global (D16). Two-tier: ${twoTier.map(format).join(', ')}. ` +
        `Hatch: ${hatch.map(format).join(', ')}. ` +
        'Every configured chain must set an operational treasury, or none may.',
    );
  }

  return [first, ...chains.slice(1)];
}

function requireSupportedChain(
  chainId: number,
  catalog: readonly SupportedChain[],
  source: string,
): SupportedChain {
  const chain = catalog.find((entry) => entry.chainId === chainId);
  if (chain === undefined) {
    throw invalidConfiguration(
      `${source} is not supported. Supported chain IDs: ${catalog.map((entry) => String(entry.chainId)).join(', ')}`,
    );
  }
  return chain;
}

function toConfiguredChain(input: {
  readonly supported: SupportedChain;
  readonly rpcUrl: string;
  readonly explorerBaseUrl: string | undefined;
  readonly treasury: TreasuryConfig;
  readonly operationalTreasury: OperationalTreasuryConfig | undefined;
}): ConfiguredChain {
  return {
    slug: input.supported.slug,
    chainId: input.supported.chainId,
    displayName: input.supported.displayName,
    nativeSymbol: input.supported.nativeSymbol,
    rpcUrl: input.rpcUrl,
    explorerBaseUrl: stripTrailingSlash(input.explorerBaseUrl ?? input.supported.defaultExplorerBaseUrl),
    treasury: input.treasury,
    operationalTreasury: input.operationalTreasury,
  };
}

function treasuryThresholdsFromEth(
  amounts: {
    readonly warningBalanceEth: string;
    readonly criticalBalanceEth: string;
    readonly recoveryBalanceEth: string;
    readonly minimumReserveEth: string;
  },
  labels: {
    readonly warning: string;
    readonly critical: string;
    readonly recovery: string;
    readonly reserve: string;
  },
): Omit<TreasuryConfig, 'address'> {
  const thresholds = {
    warningBalanceWei: parseEtherToWei(amounts.warningBalanceEth, labels.warning),
    criticalBalanceWei: parseEtherToWei(amounts.criticalBalanceEth, labels.critical),
    recoveryBalanceWei: parseEtherToWei(amounts.recoveryBalanceEth, labels.recovery),
    minimumReserveWei: parseEtherToWei(amounts.minimumReserveEth, labels.reserve),
  };
  assertValidTreasuryThresholds(thresholds);
  return thresholds;
}

function buildOperationalTreasury(input: {
  readonly rawAddress: string | undefined;
  readonly externalAddress: `0x${string}`;
  readonly addressLabel: string;
  readonly differLabel: string;
  readonly amounts: {
    readonly warningBalanceEth: string | undefined;
    readonly criticalBalanceEth: string | undefined;
    readonly recoveryBalanceEth: string | undefined;
    readonly minimumReserveEth: string | undefined;
    readonly minimumBalanceEth: string | undefined;
    readonly targetBalanceEth: string | undefined;
    readonly maximumTopUpEth: string | undefined;
  };
  readonly amountLabels: {
    readonly warning: string;
    readonly critical: string;
    readonly recovery: string;
    readonly reserve: string;
    readonly minimum: string;
    readonly target: string;
    readonly maximum: string;
  };
}): OperationalTreasuryConfig | undefined {
  if (input.rawAddress === undefined) {
    return undefined;
  }

  const address = parseConfiguredAddress(input.rawAddress, input.addressLabel);
  const required = [
    [input.amountLabels.warning, input.amounts.warningBalanceEth],
    [input.amountLabels.critical, input.amounts.criticalBalanceEth],
    [input.amountLabels.recovery, input.amounts.recoveryBalanceEth],
    [input.amountLabels.reserve, input.amounts.minimumReserveEth],
    [input.amountLabels.minimum, input.amounts.minimumBalanceEth],
    [input.amountLabels.target, input.amounts.targetBalanceEth],
    [input.amountLabels.maximum, input.amounts.maximumTopUpEth],
  ] as const;

  for (const [name, value] of required) {
    if (value === undefined) {
      throw invalidConfiguration(`${name} is required when ${input.addressLabel} is set`);
    }
  }

  const warningBalanceEth = requirePresent(input.amounts.warningBalanceEth, input.amountLabels.warning);
  const criticalBalanceEth = requirePresent(input.amounts.criticalBalanceEth, input.amountLabels.critical);
  const recoveryBalanceEth = requirePresent(input.amounts.recoveryBalanceEth, input.amountLabels.recovery);
  const minimumReserveEth = requirePresent(input.amounts.minimumReserveEth, input.amountLabels.reserve);
  const minimumBalanceEth = requirePresent(input.amounts.minimumBalanceEth, input.amountLabels.minimum);
  const targetBalanceEth = requirePresent(input.amounts.targetBalanceEth, input.amountLabels.target);
  const maximumTopUpEth = requirePresent(input.amounts.maximumTopUpEth, input.amountLabels.maximum);

  const thresholds = treasuryThresholdsFromEth(
    {
      warningBalanceEth,
      criticalBalanceEth,
      recoveryBalanceEth,
      minimumReserveEth,
    },
    {
      warning: input.amountLabels.warning,
      critical: input.amountLabels.critical,
      recovery: input.amountLabels.recovery,
      reserve: input.amountLabels.reserve,
    },
  );

  const policy = validatePolicy({
    minimumBalanceWei: parseEtherToWei(minimumBalanceEth, input.amountLabels.minimum),
    targetBalanceWei: parseEtherToWei(targetBalanceEth, input.amountLabels.target),
    maximumTopUpWei: parseEtherToWei(maximumTopUpEth, input.amountLabels.maximum),
    isEnabled: true,
  });
  if (!policy.ok) {
    throw new ChainBankError(policy.code, policy.message, {
      publicMessage: 'The service is misconfigured.',
    });
  }

  if (address.toLowerCase() === input.externalAddress.toLowerCase()) {
    throw invalidConfiguration(input.differLabel);
  }

  return {
    address,
    ...thresholds,
    policy: {
      minimumBalanceWei: policy.policy.minimumBalanceWei,
      targetBalanceWei: policy.policy.targetBalanceWei,
      maximumTopUpWei: policy.policy.maximumTopUpWei,
    },
  };
}

function parseConfiguredAddress(raw: string, label: string): `0x${string}` {
  if (!isAddress(raw, { strict: false })) {
    throw invalidConfiguration(`${label} is not a valid EVM address`);
  }
  return getAddress(raw);
}

function requirePresent<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw invalidConfiguration(`${name} is required`);
  }
  return value;
}

function invalidConfiguration(message: string): ChainBankError {
  return new ChainBankError('INVALID_CONFIGURATION', message, {
    publicMessage: 'The service is misconfigured.',
  });
}

function buildEmailConfig(env: RawEnvironment, serviceRole: ServiceRole): EmailConfig {
  if (env.EMAIL_FROM_ADDRESS === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `EMAIL_FROM_ADDRESS is required for the ${serviceRole} service`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }
  if (env.EMAIL_OPERATOR_RECIPIENTS === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `EMAIL_OPERATOR_RECIPIENTS is required for the ${serviceRole} service`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const operatorRecipients = splitList(env.EMAIL_OPERATOR_RECIPIENTS);
  if (operatorRecipients.length === 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'EMAIL_OPERATOR_RECIPIENTS must contain at least one address',
      { publicMessage: 'The service is misconfigured.' },
    );
  }
  const invalid = operatorRecipients.filter((address) => !address.includes('@'));
  if (invalid.length > 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `EMAIL_OPERATOR_RECIPIENTS contains ${String(invalid.length)} malformed address(es)`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  if (env.EMAIL_PROVIDER === 'log-only') {
    return { provider: 'log-only', fromAddress: env.EMAIL_FROM_ADDRESS, operatorRecipients };
  }

  if (env.RESEND_API_KEY === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'RESEND_API_KEY is required when EMAIL_PROVIDER is "resend"',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return {
    provider: 'resend',
    apiKey: env.RESEND_API_KEY,
    fromAddress: env.EMAIL_FROM_ADDRESS,
    operatorRecipients,
  };
}

function buildApiSecurityConfig(
  env: RawEnvironment,
  isHosted: boolean,
  trustedProxyCidrs: readonly string[],
): ApiSecurityConfig {
  const corsAllowedOrigins =
    env.CORS_ALLOWED_ORIGINS === undefined ? [] : splitList(env.CORS_ALLOWED_ORIGINS);

  if (isHosted && corsAllowedOrigins.includes('*')) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'CORS_ALLOWED_ORIGINS must not be "*" in a hosted environment',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return {
    corsAllowedOrigins,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    trustedProxyCidrs,
    fundingHealthToken: env.FUNDING_HEALTH_TOKEN,
  };
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
