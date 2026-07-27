import { getAddress, isAddress } from 'viem';
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
export type ServiceRole = 'web' | 'treasury-monitor';

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
}

export interface ChainBankConfig {
  readonly app: AppConfig;
  readonly database: DatabaseConfig;
  readonly chain: ChainConfig;
  readonly treasury: TreasuryConfig;
  /** Absent for roles that must not hold email provider credentials. */
  readonly email: EmailConfig | undefined;
  /** Absent for non-API roles. */
  readonly apiSecurity: ApiSecurityConfig | undefined;
  readonly isFundingEnabled: false;
}

/** Default pool ceilings. A short-lived cron needs far fewer connections than the API. */
const DEFAULT_POOL_MAX: Readonly<Record<ServiceRole, number>> = {
  web: 10,
  'treasury-monitor': 2,
};

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
  const parsed = environmentSchema.safeParse(source);

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

  if (env.FUNDING_ENABLED) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'FUNDING_ENABLED must be false. This build contains no transaction-signing path, ' +
        'so enabling it would misrepresent the service as able to move funds.',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

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
    email: options.serviceRole === 'web' ? buildEmailConfig(env) : undefined,
    apiSecurity: options.serviceRole === 'web' ? buildApiSecurityConfig(env, isHosted) : undefined,
    isFundingEnabled: false,
  };
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

  return {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX[serviceRole],
    useSsl,
    sslCertificateAuthority,
  };
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
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'TREASURY_ADDRESS is not a valid EVM address',
      { publicMessage: 'The service is misconfigured.' },
    );
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

function buildEmailConfig(env: RawEnvironment): EmailConfig {
  if (env.EMAIL_FROM_ADDRESS === undefined) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'EMAIL_FROM_ADDRESS is required for the web service', {
      publicMessage: 'The service is misconfigured.',
    });
  }
  if (env.EMAIL_OPERATOR_RECIPIENTS === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'EMAIL_OPERATOR_RECIPIENTS is required for the web service',
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
  const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS === undefined ? [] : splitList(env.CORS_ALLOWED_ORIGINS);

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
