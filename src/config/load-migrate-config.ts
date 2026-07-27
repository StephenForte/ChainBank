import { z } from 'zod';
import { ChainBankError } from '../domain/errors.js';
import type { DatabaseConfig } from './index.js';

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/**
 * Minimal environment for schema migrations.
 *
 * Pre-deploy must not depend on treasury thresholds, RPC, or email. Those are
 * validated when the web service and cron actually start.
 */
const migrateEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CHAINBANK_ENVIRONMENT: z.enum(['local', 'hosted-development', 'hosted-staging']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().trim().min(1, 'is required'),
  DATABASE_SSL: booleanFlag.optional(),
  DATABASE_SSL_CA: z.string().trim().min(1).optional(),
});

export interface MigrateConfig {
  readonly environment: 'local' | 'hosted-development' | 'hosted-staging';
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly database: DatabaseConfig;
}

export function loadMigrateConfig(env: NodeJS.ProcessEnv = process.env): MigrateConfig {
  const parsed = migrateEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ChainBankError('INVALID_CONFIGURATION', `Invalid migration configuration:\n${details}`, {
      publicMessage: 'The service is misconfigured.',
    });
  }

  const isHosted = parsed.data.CHAINBANK_ENVIRONMENT !== 'local';
  return {
    environment: parsed.data.CHAINBANK_ENVIRONMENT,
    logLevel: parsed.data.LOG_LEVEL,
    database: {
      url: parsed.data.DATABASE_URL,
      poolMax: 1,
      useSsl: parsed.data.DATABASE_SSL ?? isHosted,
      sslCertificateAuthority: parsed.data.DATABASE_SSL_CA,
    },
  };
}
