import { z } from 'zod';

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

  CHAIN_ID: positiveInteger,
  CHAIN_RPC_URL: httpUrl,
  CHAIN_EXPLORER_BASE_URL: httpUrl.optional(),

  TREASURY_ADDRESS: z.string().trim().min(1, 'is required'),
  TREASURY_WARNING_BALANCE_ETH: decimalEther,
  TREASURY_CRITICAL_BALANCE_ETH: decimalEther,
  TREASURY_RECOVERY_BALANCE_ETH: decimalEther,
  TREASURY_MINIMUM_RESERVE_ETH: decimalEther,

  EMAIL_PROVIDER: z.enum(['resend', 'log-only']).default('resend'),
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  EMAIL_FROM_ADDRESS: emailAddress.optional(),
  EMAIL_OPERATOR_RECIPIENTS: z.string().trim().min(1).optional(),

  CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
  RATE_LIMIT_MAX: positiveInteger.default(120),
  RATE_LIMIT_WINDOW_SECONDS: positiveInteger.default(60),
  /**
   * Number of trusted reverse-proxy hops in front of the service. Render adds
   * exactly one. Must never be expressed as "trust everything": that would let
   * a client forge its own source address through X-Forwarded-For.
   */
  TRUSTED_PROXY_HOPS: positiveInteger.default(1),

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
   * Treasury signing key. Parsed only for signing-capable service roles.
   * Required when FUNDING_ENABLED=true for those roles. Never accepted into
   * treasury-monitor configuration.
   */
  TREASURY_PRIVATE_KEY: z.string().trim().min(1).optional(),

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
});

export type RawEnvironment = z.infer<typeof environmentSchema>;
