import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  readCookie,
  readSessionToken,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from '../../../src/api/cookies.js';

describe('session cookies', () => {
  it('treats an absent or malformed cookie header as no session', () => {
    expect(readSessionToken(undefined)).toBeUndefined();
    expect(readSessionToken('')).toBeUndefined();
    expect(readSessionToken('not a cookie')).toBeUndefined();
    expect(readCookie('=novalue', SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readSessionToken('chainbank_session=')).toBeUndefined();
  });

  it('reads the named cookie when several are present and keeps the first', () => {
    expect(readSessionToken('other=1; chainbank_session=abc_DEF-123; third=no')).toBe('abc_DEF-123');
    expect(readSessionToken('chainbank_session=first; chainbank_session=second')).toBe('first');
  });

  it('emits HttpOnly SameSite=Strict and drops Secure only when asked', () => {
    const hosted = serializeSessionCookie('abc', { maxAgeSeconds: 43_200, secure: true });
    expect(hosted).toBe('chainbank_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200');

    const local = serializeSessionCookie('abc', { maxAgeSeconds: 43_200, secure: false });
    expect(local).toBe('chainbank_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
    expect(local.includes('Secure')).toBe(false);

    expect(clearSessionCookie(true)).toBe(
      'chainbank_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    );
  });
});
