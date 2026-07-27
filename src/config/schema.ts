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
   * Global kill switch from the operational safety requirements. Phase 0 ships
   * no signing path at all, so this must stay false; configuration validation
   * rejects `true` rather than letting an operator believe funding is armed.
   */
  FUNDING_ENABLED: booleanFlag.default(false),
});

export type RawEnvironment = z.infer<typeof environmentSchema>;
