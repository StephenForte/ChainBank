import { ChainBankError } from '../domain/errors.js';

/**
 * Shared pagination contract for list endpoints (AGENTS.md §8).
 *
 * Query strings are declared as **strings with a digit pattern**, not integers.
 * The app configures ajv with `coerceTypes: false` (src/api/app.ts), so a
 * `type: 'integer'` query parameter can never validate — HTTP delivers query
 * values as strings, and without coercion `"50"` is not an integer. Declaring
 * them as integers makes the endpoint reject every request that supplies
 * pagination, which is how `GET /v1/admin/credentials?limit=50` and
 * `GET /v1/projects?limit=50` shipped broken.
 *
 * Centralised so the next list endpoint inherits the working shape instead of
 * re-deciding it: two routes previously got this right and two did not.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Query-string fragment for `limit` / `offset`. Spread into a `querystring` schema. */
export const paginationQuerySchema = {
  limit: { type: 'string', pattern: '^[0-9]+$' },
  offset: { type: 'string', pattern: '^[0-9]+$' },
} as const;

/** Response fragment describing the echoed pagination block. */
export const paginationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['limit', 'offset', 'total'],
  properties: {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    total: { type: 'integer' },
  },
} as const;

export interface PaginationQuery {
  readonly limit?: string;
  readonly offset?: string;
}

export function parsePageLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`,
      { publicMessage: `limit must be between 1 and ${String(MAX_PAGE_LIMIT)}.` },
    );
  }
  return value;
}

export function parsePageOffset(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChainBankError('INVALID_REQUEST', 'offset must be a non-negative integer', {
      publicMessage: 'offset must be a non-negative integer.',
    });
  }
  return value;
}
