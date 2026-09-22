import { z } from 'zod';
import { DEFAULT_TRUSTED_PROXY_CIDRS } from './trusted-proxy.js';

const decimalEther = z.preprocess(
  (value) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
  },
  z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/, 'must be a non-negative decimal ETH amount with at most 18 decimal places'),
);

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .describe('true or false');

const positiveInteger = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a positive integer')
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => value > 0, 'must be greater than zero');

const nonNegativeInteger = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => value >= 0 && Number.isSafeInteger(value), 'must be a non-negative safe integer');

const httpUrl = z
  .url({ protocol: /^https?$/, message: 'must be an absolute http(s) URL' })
  .trim()
  .min(1);

const emailAddress = z.email('must be a valid email address').trim();

/**
 * Singular chain and treasury variables — the form deployed on Render today.
 * Mutually exclusive with `CHAINS` (C27). Signing keys are not in this list:
 * one key produces a signer per chain, and a secret must not sit inside the
 * chain document next to non-secret values.
 */
export const SINGULAR_CHAIN_ENV_KEYS = [
  'CHAIN_ID',
  'CHAIN_RPC_URL',
  'CHAIN_EXPLORER_BASE_URL',
  'TREASURY_ADDRESS',
  'TREASURY_WARNING_BALANCE_ETH',
  'TREASURY_CRITICAL_BALANCE_ETH',
  'TREASURY_RECOVERY_BALANCE_ETH',
  'TREASURY_MINIMUM_RESERVE_ETH',
  'TREASURY_OPERATIONAL_ADDRESS',
  'TREASURY_OPERATIONAL_WARNING_BALANCE_ETH',
  'TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH',
  'TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH',
  'TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH',
  'TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH',
  'TREASURY_OPERATIONAL_TARGET_BALANCE_ETH',
  'TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH',
] as const;

/** Required when `CHAINS` is unset. Explorer URL and operational treasury stay optional. */
export const REQUIRED_SINGULAR_CHAIN_ENV_KEYS = [
  'CHAIN_ID',
  'CHAIN_RPC_URL',
  'TREASURY_ADDRESS',
  'TREASURY_WARNING_BALANCE_ETH',
  'TREASURY_CRITICAL_BALANCE_ETH',
  'TREASURY_RECOVERY_BALANCE_ETH',
  'TREASURY_MINIMUM_RESERVE_ETH',
] as const;

const chainTreasuryDocumentSchema = z.strictObject({
  address: z.string().trim().min(1),
  warningBalanceEth: decimalEther,
  criticalBalanceEth: decimalEther,
  recoveryBalanceEth: decimalEther,
  minimumReserveEth: decimalEther,
});

const operationalTreasuryDocumentSchema = z.strictObject({
  address: z.string().trim().min(1),
  warningBalanceEth: decimalEther,
  criticalBalanceEth: decimalEther,
  recoveryBalanceEth: decimalEther,
  minimumReserveEth: decimalEther,
  minimumBalanceEth: decimalEther,
  targetBalanceEth: decimalEther,
  maximumTopUpEth: decimalEther,
});

/**
 * One element of the `CHAINS` JSON document. Amounts are decimal strings, never
 * JSON numbers, so wei is not parsed through floating point. Unknown keys are
 * rejected — including a private key pasted into the document.
 */
export const chainDocumentSchema = z.strictObject({
  chainId: z
    .number()
    .int()
    .positive()
    .refine((value) => Number.isSafeInteger(value), 'must be a safe integer'),
  rpcUrl: httpUrl,
  explorerBaseUrl: httpUrl.optional(),
  treasury: chainTreasuryDocumentSchema,
  operationalTreasury: operationalTreasuryDocumentSchema.optional(),
});

export type ChainDocument = z.infer<typeof chainDocumentSchema>;

/**
 * Raw environment shape. Every value arrives as a string, so parsing and
 * coercion happen here and nowhere else. Unknown variables are ignored rather
 * than rejected, because hosting platforms inject their own.
 */
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CHAINBANK_ENVIRONMENT: z.enum(['local', 'hosted-development', 'hosted-staging']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: positiveInteger.default(3000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PUBLIC_BASE_URL: httpUrl.default('http://localhost:3000'),

  DATABASE_URL: z.string().trim().min(1, 'is required'),
  DATABASE_POOL_MAX: positiveInteger.optional(),
  DATABASE_SSL: booleanFlag.optional(),
  /** PEM certificate authority, for TLS to a database whose CA is not in the system trust store. */
  DATABASE_SSL_CA: z.string().trim().min(1).optional(),

  /**
   * Multi-chain document. When set, the singular CHAIN_* / TREASURY_* variables
   * below must be absent. Empty is treated as unset so a blank dashboard value
   * does not hide the singular form. See C27.
   */
  CHAINS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),

  /**
   * Singular chain form. Optional at parse time so `CHAINS` can be used alone;
   * `loadConfig` requires these when `CHAINS` is unset, and rejects them when
   * `CHAINS` is set.
   */
  CHAIN_ID: positiveInteger.optional(),
  CHAIN_RPC_URL: httpUrl.optional(),
  CHAIN_EXPLORER_BASE_URL: httpUrl.optional(),

  TREASURY_ADDRESS: z.string().trim().min(1).optional(),
  TREASURY_WARNING_BALANCE_ETH: decimalEther.optional(),
  TREASURY_CRITICAL_BALANCE_ETH: decimalEther.optional(),
  TREASURY_RECOVERY_BALANCE_ETH: decimalEther.optional(),
  TREASURY_MINIMUM_RESERVE_ETH: decimalEther.optional(),

  /**
   * Private (operational) treasury. When unset, the process stays in the
   * single-treasury hatch (C23): wallets still spend from TREASURY_ADDRESS.
   */
  TREASURY_OPERATIONAL_ADDRESS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  TREASURY_OPERATIONAL_WARNING_BALANCE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_CRITICAL_BALANCE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_RECOVERY_BALANCE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_MINIMUM_RESERVE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_MINIMUM_BALANCE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_TARGET_BALANCE_ETH: decimalEther.optional(),
  TREASURY_OPERATIONAL_MAXIMUM_TOP_UP_ETH: decimalEther.optional(),

  EMAIL_PROVIDER: z.enum(['resend', 'log-only']).default('resend'),
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  EMAIL_FROM_ADDRESS: emailAddress.optional(),
  EMAIL_OPERATOR_RECIPIENTS: z.string().trim().min(1).optional(),

  CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
  RATE_LIMIT_MAX: positiveInteger.default(120),
  RATE_LIMIT_WINDOW_SECONDS: positiveInteger.default(60),
  /**
   * Comma-separated addresses or CIDRs of peers allowed to set X-Forwarded-*.
   * Matched against the socket address. A hop count is not accepted: it
   * ignores that address. Empty is rejected rather than treated as trust-all.
   * The default is private and loopback space, not a claim about any
   * platform's published proxy ranges.
   */
  TRUSTED_PROXY_CIDRS: z.string().trim().min(1).default(DEFAULT_TRUSTED_PROXY_CIDRS),

  /**
   * Arms funding workflows for signing-capable roles. Requires a structurally
   * valid TREASURY_PRIVATE_KEY for those roles; the treasury-monitor role never
   * reads the key and always boots with funding disabled.
   */
  FUNDING_ENABLED: booleanFlag.default(false),

  /**
   * Operational emergency stop. When true, every signing method refuses with
   * FUNDING_DISABLED while read paths continue to work.
   */
  FUNDING_KILL_SWITCH: booleanFlag.default(false),

  /**
   * Treasury signing key. Parsed only for signing-capable service roles
   * (`web`, `cron-reconciler`). Required when FUNDING_ENABLED=true for those
   * roles. Never accepted into treasury-monitor configuration.
   */
  TREASURY_PRIVATE_KEY: z.string().trim().min(1).optional(),

  /**
   * Operational-treasury signing key. Parsed only for signing-capable roles.
   * Required when FUNDING_ENABLED=true and TREASURY_OPERATIONAL_ADDRESS is set.
   */
  TREASURY_OPERATIONAL_PRIVATE_KEY: z.string().trim().min(1).optional(),

  /** Receipt confirmations before a funding tx is marked confirmed (D4). */
  FUNDING_CONFIRMATIONS: positiveInteger.default(1),

  /**
   * Max wait for confirmations. Timeout leaves the tx `submitted` / operation
   * resumable as `pending` — never a false failure (D4).
   */
  FUNDING_CONFIRMATION_TIMEOUT_MS: positiveInteger.default(60_000),

  /**
   * Hours between unresolved treasury alert reminder emails (P3-US2).
   * Used by treasury-monitor and the manual check-now path.
   */
  ALERT_REMINDER_INTERVAL_HOURS: nonNegativeInteger.default(24),

  /**
   * Maximum treasury-outgoing blocks scanned per reconciler run (C14 / TX.9).
   * Incremental resume uses the per-treasury watermark; this cap bounds each
   * run (first run / long outage). Default 20000 (~2.8 days at Sepolia ~12s).
   */
  RECONCILE_OUTGOING_LOOKBACK_BLOCKS: positiveInteger.default(20_000),

  /**
   * Consecutive reconciliation-run failures before paging the operator (P4-US3 / C15).
   * Consumed by the cron-reconciler via config.alerts.reconcileFailureAlertThreshold.
   */
  RECONCILE_FAILURE_ALERT_THRESHOLD: positiveInteger.default(3),

  /**
   * Bearer token for GET /health/funding (web role). Optional at boot so existing
   * deploys keep starting; when unset the endpoint rejects every request.
   * Balances are public on-chain, but the wallet inventory + policy mins are not
   * free disclosure — ForteL2 holds this secret under its own conventions.
   */
  FUNDING_HEALTH_TOKEN: z.string().trim().min(1).optional(),
});

export type RawEnvironment = z.infer<typeof environmentSchema>;
