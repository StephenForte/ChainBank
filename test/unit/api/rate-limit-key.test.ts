import { describe, expect, it } from 'vitest';
import { rateLimitKeyOf } from '../../../src/api/app.js';

/**
 * Rate limiting runs at `onRequest`, before authentication. Buckets must not
 * partition on an unauthenticated Bearer/session value — a unique token per
 * request would bypass the IP cap while still hitting the credential store.
 */
describe('rateLimitKeyOf', () => {
  const request = (headers: Record<string, string>, ip = '203.0.113.10') => ({ headers, ip });

  it('keys every request by client IP', () => {
    expect(rateLimitKeyOf(request({}))).toBe('ip:203.0.113.10');
    expect(rateLimitKeyOf(request({ authorization: 'Bearer cb_example-token' }))).toBe('ip:203.0.113.10');
    expect(rateLimitKeyOf(request({ cookie: 'chainbank_session=session-token-value' }))).toBe(
      'ip:203.0.113.10',
    );
  });

  it('does not open a fresh bucket for a unique Bearer value', () => {
    expect(rateLimitKeyOf(request({ authorization: 'Bearer cb_one' }))).toBe(
      rateLimitKeyOf(request({ authorization: 'Bearer cb_two' })),
    );
  });

  it('never places a raw token in the key', () => {
    const key = rateLimitKeyOf(request({ authorization: 'Bearer cb_secret-value' }));
    expect(key).not.toContain('cb_secret-value');
  });

  it('separates distinct source addresses into distinct buckets', () => {
    const headers = { authorization: 'Bearer cb_same-token' };
    expect(rateLimitKeyOf(request(headers, '198.51.100.1'))).not.toBe(
      rateLimitKeyOf(request(headers, '198.51.100.2')),
    );
  });
});
