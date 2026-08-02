import { getAddress, isAddress, isHex } from 'viem';
import { ChainBankError } from '../domain/errors.js';
import { assertValidTreasuryThresholds } from '../domain/treasury/treasury-status.js';
import { parseEtherToWei } from '../domain/wei.js';
import { environmentSchema, type RawEnvironment } from './schema.js';
import { findSupportedChainById, supportedChainIds, type SupportedChain } from './supported-chains.js';

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

export interface TreasuryConfig {
  readonly address: `0x${string}`;
  readonly warningBalanceWei: bigint;
  readonly criticalBalanceWei: bigint;
  readonly recoveryBalanceWei: bigint;
  readonly minimumReserveWei: bigint;
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
  readonly trustedProxyHops: number;
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
  readonly chain: ChainConfig;
  readonly treasury: TreasuryConfig;
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
  const envSource = isSigningCapableRole(options.serviceRole)
    ? source
    : omitEnvKey(source, 'TREASURY_PRIVATE_KEY');
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
  const funding = buildFundingConfig(env, options.serviceRole);

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
    chain: buildChainConfig(env),
    treasury: buildTreasuryConfig(env),
    email: requiresEmailConfig(options.serviceRole) ? buildEmailConfig(env, options.serviceRole) : undefined,
    apiSecurity: options.serviceRole === 'web' ? buildApiSecurityConfig(env, isHosted) : undefined,
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

function buildFundingConfig(env: RawEnvironment, serviceRole: ServiceRole): FundingConfig {
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
    });
  }

  const rawKey = env.TREASURY_PRIVATE_KEY;
  const privateKey = rawKey === undefined ? undefined : parseTreasuryPrivateKey(rawKey, env.FUNDING_ENABLED);

  if (env.FUNDING_ENABLED && privateKey === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'FUNDING_ENABLED=true requires a structurally valid TREASURY_PRIVATE_KEY ' +
        'for this signing-capable service role. Provide a 32-byte hex private key ' +
        '(0x-prefixed, 64 hex digits), or set FUNDING_ENABLED=false.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return createFundingConfig({
    enabled: env.FUNDING_ENABLED,
    killSwitch,
    confirmations,
    confirmationTimeoutMs,
    privateKey,
  });
}

function createFundingConfig(input: {
  readonly enabled: boolean;
  readonly killSwitch: boolean;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  readonly privateKey: `0x${string}` | undefined;
}): FundingConfig {
  // Keep the private key non-enumerable so JSON.stringify(config) cannot leak it.
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
  return funding;
}

function omitEnvKey(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy[key];
  return copy;
}

/**
 * Structurally validates a treasury private key.
 *
 * When funding is enabled, any absent/malformed value is a hard startup failure.
 * When funding is disabled, a present-but-malformed value still fails closed so
 * a bad secret cannot sit unnoticed until the operator flips the gate.
 */
function parseTreasuryPrivateKey(rawKey: string, isFundingEnabled: boolean): `0x${string}` | undefined {
  if (!isStructurallyValidPrivateKey(rawKey)) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      isFundingEnabled
        ? 'FUNDING_ENABLED=true but TREASURY_PRIVATE_KEY is malformed. ' +
            'Expected a 0x-prefixed 32-byte hex private key (64 hex digits). ' +
            'Fix or remove the key, or set FUNDING_ENABLED=false.'
        : 'TREASURY_PRIVATE_KEY is present but malformed. ' +
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

function buildChainConfig(env: RawEnvironment): ChainConfig {
  const chain: SupportedChain | undefined = findSupportedChainById(env.CHAIN_ID);
  if (chain === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `CHAIN_ID ${String(env.CHAIN_ID)} is not supported. Supported chain IDs: ` +
        supportedChainIds().join(', '),
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  return {
    slug: chain.slug,
    chainId: chain.chainId,
    displayName: chain.displayName,
    nativeSymbol: chain.nativeSymbol,
    rpcUrl: env.CHAIN_RPC_URL,
    explorerBaseUrl: stripTrailingSlash(env.CHAIN_EXPLORER_BASE_URL ?? chain.defaultExplorerBaseUrl),
  };
}

function buildTreasuryConfig(env: RawEnvironment): TreasuryConfig {
  if (!isAddress(env.TREASURY_ADDRESS, { strict: false })) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'TREASURY_ADDRESS is not a valid EVM address', {
      publicMessage: 'The service is misconfigured.',
    });
  }

  const thresholds = {
    warningBalanceWei: parseEtherToWei(env.TREASURY_WARNING_BALANCE_ETH, 'TREASURY_WARNING_BALANCE_ETH'),
    criticalBalanceWei: parseEtherToWei(env.TREASURY_CRITICAL_BALANCE_ETH, 'TREASURY_CRITICAL_BALANCE_ETH'),
    recoveryBalanceWei: parseEtherToWei(env.TREASURY_RECOVERY_BALANCE_ETH, 'TREASURY_RECOVERY_BALANCE_ETH'),
    minimumReserveWei: parseEtherToWei(env.TREASURY_MINIMUM_RESERVE_ETH, 'TREASURY_MINIMUM_RESERVE_ETH'),
  };
  assertValidTreasuryThresholds(thresholds);

  return { address: getAddress(env.TREASURY_ADDRESS), ...thresholds };
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

function buildApiSecurityConfig(env: RawEnvironment, isHosted: boolean): ApiSecurityConfig {
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
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
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
