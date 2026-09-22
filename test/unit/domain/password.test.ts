import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_RECORD,
  hashPassword,
  isScryptPasswordParams,
  SCRYPT_KEY_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  verifyPassword,
} from '../../../src/domain/auth/password.js';

describe('scrypt passwords', () => {
  it('accepts the password that was hashed and rejects a one-character change', async () => {
    const password = 'correct-horse-battery';
    const record = await hashPassword(password);

    expect(await verifyPassword(password, record)).toBe(true);
    expect(await verifyPassword(`${password}x`, record)).toBe(false);
    expect(await verifyPassword(password.slice(0, -1) + 'X', record)).toBe(false);
  });

  it('never stores the password as the hash', async () => {
    const password = 'correct-horse-battery';
    const record = await hashPassword(password);

    expect(record.passwordHash).not.toBe(password);
    expect(record.passwordHash.includes(password)).toBe(false);
    expect(JSON.stringify(record.passwordParams).includes(password)).toBe(false);
  });

  it('round-trips parameters through JSON the way jsonb will', async () => {
    const password = 'correct-horse-battery';
    const record = await hashPassword(password);
    const parsed: unknown = JSON.parse(JSON.stringify(record.passwordParams));

    expect(isScryptPasswordParams(parsed)).toBe(true);
    if (!isScryptPasswordParams(parsed)) {
      return;
    }
    expect(parsed).toEqual({
      algorithm: 'scrypt',
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: record.passwordParams.salt,
      keyLength: SCRYPT_KEY_LENGTH,
    });
    expect(
      await verifyPassword(password, { passwordHash: record.passwordHash, passwordParams: parsed }),
    ).toBe(true);
  });

  it('verifies the fixed dummy record with its own password and rejects any other', async () => {
    expect(await verifyPassword('not-a-user-password', DUMMY_PASSWORD_RECORD)).toBe(true);
    expect(await verifyPassword('someone-elses-password', DUMMY_PASSWORD_RECORD)).toBe(false);
  });
});
