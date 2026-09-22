import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../../../src/domain/auth/session-token.js';
import { hashApiToken } from '../../../src/shared/api-token.js';

describe('session tokens', () => {
  it('hashes with the same SHA-256 as an API token', () => {
    const generated = generateSessionToken();

    expect(generated.tokenHash).toBe(hashApiToken(generated.token));
    expect(generated.tokenHash).toBe(hashSessionToken(generated.token));
    expect(generated.tokenHash).not.toBe(generated.token);
    expect(generated.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(generated.token, 'base64url')).toHaveLength(32);
  });
});
