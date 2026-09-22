import { randomBytes } from 'node:crypto';
import { hashApiToken } from '../../shared/api-token.js';

const SESSION_ENTROPY_BYTES = 32;

export interface GeneratedSessionToken {
  /** Shown to the browser once, in the cookie. Never persisted. */
  readonly token: string;
  readonly tokenHash: string;
}

/**
 * 256-bit session token, base64url, hashed with the same SHA-256 as API tokens.
 *
 * That hash is appropriate only because the token is generated entropy. It
 * must not be used for passwords; those go through scrypt in `password.ts`.
 */
export function generateSessionToken(): GeneratedSessionToken {
  const token = randomBytes(SESSION_ENTROPY_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return hashApiToken(token);
}
