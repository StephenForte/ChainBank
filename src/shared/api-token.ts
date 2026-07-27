import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'cb_';
const TOKEN_ENTROPY_BYTES = 32;
const STORED_PREFIX_LENGTH = 11;

export interface GeneratedApiToken {
  /** Shown to the operator exactly once. Never persisted. */
  readonly token: string;
  readonly tokenHash: string;
  /** Non-secret fragment used to identify the credential in logs and the UI. */
  readonly tokenPrefix: string;
}

export function generateApiToken(): GeneratedApiToken {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
  return {
    token,
    tokenHash: hashApiToken(token),
    tokenPrefix: token.slice(0, STORED_PREFIX_LENGTH),
  };
}

/**
 * Hashes a bearer token for storage and lookup.
 *
 * A single SHA-256 pass is appropriate here: tokens carry 256 bits of
 * generated entropy, so there is no guessable input for an attacker with the
 * hash to brute force. Password-style stretching would add cost without
 * addressing any real threat. This must not be reused for operator passwords.
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenPrefixOf(token: string): string {
  return token.slice(0, STORED_PREFIX_LENGTH);
}
