import { describe, expect, it } from 'vitest';
import { generateApiToken, hashApiToken, tokenPrefixOf } from '../../../src/shared/api-token.js';

describe('api tokens', () => {
  it('generates cb_-prefixed tokens with a stable hash and prefix', () => {
    const generated = generateApiToken();

    expect(generated.token.startsWith('cb_')).toBe(true);
    expect(generated.tokenHash).toBe(hashApiToken(generated.token));
    expect(generated.tokenPrefix).toBe(tokenPrefixOf(generated.token));
    expect(generated.tokenPrefix).not.toBe(generated.token);
  });

  it('never stores the raw token as the hash', () => {
    const generated = generateApiToken();
    expect(generated.tokenHash).not.toContain(generated.token);
    expect(generated.tokenHash).toHaveLength(64);
  });

  it('produces unique tokens across generations', () => {
    const first = generateApiToken();
    const second = generateApiToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});
