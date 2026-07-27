import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

/**
 * Central redaction list.
 *
 * Every credential-shaped field is scrubbed here rather than at each call site,
 * because a log statement added in a hurry is exactly where a secret leaks.
 * Paths are matched by pino at fixed depths, so both bare and nested forms are
 * listed for the shapes we actually construct.
 */
const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  '*.authorization',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'token',
  '*.token',
  '*.*.token',
  'password',
  '*.password',
  'privateKey',
  '*.privateKey',
  '*.*.privateKey',
  'secret',
  '*.secret',
  'databaseUrl',
  '*.databaseUrl',
  'rpcUrl',
  '*.rpcUrl',
  'DATABASE_URL',
  'RESEND_API_KEY',
  'CHAIN_RPC_URL',
  'TREASURY_PRIVATE_KEY',
];

export interface CreateLoggerOptions {
  readonly level: string;
  readonly serviceRole: string;
  readonly environment: string;
  /** Test-only sink. Production and development both emit newline-delimited JSON. */
  readonly destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: {
      service: 'chainbank',
      role: options.serviceRole,
      environment: options.environment,
    },
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  return options.destination === undefined ? pino(loggerOptions) : pino(loggerOptions, options.destination);
}

export type { Logger };

export const redactedPathsForTesting: readonly string[] = REDACTED_PATHS;
