import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginationQuerySchema,
  parsePageLimit,
  parsePageOffset,
} from '../../../src/api/pagination.js';

/**
 * Regression cover for a live defect: `GET /v1/admin/credentials?limit=50` and
 * `GET /v1/projects?limit=50` returned INVALID_REQUEST for every request that
 * supplied pagination.
 *
 * The app runs ajv with `coerceTypes: false`, and HTTP delivers query values as
 * strings, so a `type: 'integer'` query parameter can never validate. Service
 * -level unit tests never saw it because they bypass the schema layer, and the
 * integration test happened to call the endpoint without a query string.
 *
 * Built through Fastify rather than ajv directly: ajv is a transitive
 * dependency of Fastify, not a declared one, and this exercises the real
 * validation path anyway.
 */
function buildProbe(querystringProperties: Record<string, unknown>) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  app.get(
    '/probe',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: querystringProperties,
        },
      },
    },
    (request) => request.query,
  );
  return app;
}

describe('pagination query schema under the app ajv settings', () => {
  it('accepts the string values a query string actually delivers', async () => {
    const app = buildProbe({ ...paginationQuerySchema });
    for (const url of ['/probe?limit=50&offset=0', '/probe?limit=1', '/probe']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `expected ${url} to validate`).toBe(200);
    }
    await app.close();
  });

  it('rejects non-numeric and unknown query parameters', async () => {
    const app = buildProbe({ ...paginationQuerySchema });
    for (const url of ['/probe?limit=abc', '/probe?offset=-1', '/probe?limit=1.5', '/probe?page=2']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `expected ${url} to be rejected`).toBe(400);
    }
    await app.close();
  });

  it('would have failed with an integer-typed schema — the shape of the original bug', async () => {
    const app = buildProbe({
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT },
      offset: { type: 'integer', minimum: 0 },
    });
    const response = await app.inject({ method: 'GET', url: '/probe?limit=50&offset=0' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('parsePageLimit', () => {
  it('defaults when absent', () => {
    expect(parsePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('parses valid values and boundaries', () => {
    expect(parsePageLimit('1')).toBe(1);
    expect(parsePageLimit('50')).toBe(50);
    expect(parsePageLimit(String(MAX_PAGE_LIMIT))).toBe(MAX_PAGE_LIMIT);
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(() => parsePageLimit('0')).toThrow(ChainBankError);
    expect(() => parsePageLimit(String(MAX_PAGE_LIMIT + 1))).toThrow(ChainBankError);
    expect(() => parsePageLimit('abc')).toThrow(ChainBankError);
  });
});

describe('parsePageOffset', () => {
  it('defaults to zero when absent', () => {
    expect(parsePageOffset(undefined)).toBe(0);
  });

  it('parses valid values', () => {
    expect(parsePageOffset('0')).toBe(0);
    expect(parsePageOffset('250')).toBe(250);
  });

  it('rejects negative and non-numeric values', () => {
    expect(() => parsePageOffset('-1')).toThrow(ChainBankError);
    expect(() => parsePageOffset('abc')).toThrow(ChainBankError);
  });
});
