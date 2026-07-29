import { describe, expect, it } from 'vitest';
import { rateLimitKeyOf } from '../../../src/api/app.js';
import { hashApiToken } from '../../../src/shared/api-token.js';

/**
 * Rate limiting runs at `onRequest`, before the route `preHandler` that
 * authenticates. Keying on `request.actor` therefore silently degrades every
 * limit to per-IP — and `request.ip` is client-influenced behind a proxy. These
 * tests pin the credential-derived key (PRD §15.3).
 */
describe('rateLimitKeyOf', () => {
  const request = (headers: Record<string, string>, ip = '203.0.113.10') => ({ headers, ip });

  it('keys on the presented bearer token, not the source address', () => {
    const key = rateLimitKeyOf(request({ authorization: 'Bearer cb_example-token' }));
    expect(key).toBe(`tok:${hashApiToken('cb_example-token')}`);
    expect(key).not.toContain('203.0.113.10');
  });

  it('never places the raw token in the key', () => {
    const key = rateLimitKeyOf(request({ authorization: 'Bearer cb_secret-value' }));
    expect(key).not.toContain('cb_secret-value');
  });

  it('gives one credential the same bucket regardless of source address', () => {
    const headers = { authorization: 'Bearer cb_same-token' };
    expect(rateLimitKeyOf(request(headers, '198.51.100.1'))).toBe(
      rateLimitKeyOf(request(headers, '198.51.100.2')),
    );
  });

  it('separates distinct credentials into distinct buckets', () => {
    expect(rateLimitKeyOf(request({ authorization: 'Bearer cb_one' }))).not.toBe(
      rateLimitKeyOf(request({ authorization: 'Bearer cb_two' })),
    );
  });

  it('falls back to the source address only when no bearer token is presented', () => {
    expect(rateLimitKeyOf(request({}))).toBe('ip:203.0.113.10');
    expect(rateLimitKeyOf(request({ authorization: 'Basic abc' }))).toBe('ip:203.0.113.10');
  });

  it('buckets a malformed-but-present token by token, so it cannot share an IP bucket', () => {
    expect(rateLimitKeyOf(request({ authorization: 'bearer   cb_lowercase-scheme' }))).toBe(
      `tok:${hashApiToken('cb_lowercase-scheme')}`,
    );
  });
});
