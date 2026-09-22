import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ChainBankError } from '../errors.js';

/**
 * scrypt parameters for dashboard passwords (C31).
 *
 * Stored with each hash so a later cost change is a migration of rows, not a
 * second code path. Node's default `maxmem` (32 MiB) rejects N=2^15, r=8
 * because the algorithm needs 128*N*r bytes, which is exactly 32 MiB and
 * OpenSSL treats that as over the limit. `SCRYPT_MAXMEM` is a process ceiling,
 * not a KDF output, so it is not stored on the row.
 */
export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export interface ScryptPasswordParams {
  readonly algorithm: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  /** Base64 salt. Never the password. */
  readonly salt: string;
  readonly keyLength: number;
}

export interface PasswordRecord {
  /** Hex-encoded derived key. Never the password. */
  readonly passwordHash: string;
  readonly passwordParams: ScryptPasswordParams;
}

/**
 * Fixed record verified when no user matches the email.
 *
 * The derived key is scrypt("not-a-user-password") with the salt below. Login
 * discards the boolean and returns the same 401 either way; the point is that
 * a missing user still pays the same scrypt cost as a real row.
 */
export const DUMMY_PASSWORD_RECORD: PasswordRecord = {
  passwordHash:
    '1955227a26a7f96bbb5a3f940a85b887b65849bf506454b40b04205430e0f489491d0a1e9705186b694913dc804d0d9fc892865cbe5ffccac39bc32b18715609',
  passwordParams: {
    algorithm: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: 'wP/uAcD/7gLA/+4DwP/uBA==',
    keyLength: SCRYPT_KEY_LENGTH,
  },
};

export function assertAcceptablePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Password length ${String(password.length)} is outside ${String(MIN_PASSWORD_LENGTH)}..${String(MAX_PASSWORD_LENGTH)}`,
      { publicMessage: `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.` },
    );
  }
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const passwordParams: ScryptPasswordParams = {
    algorithm: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    keyLength: SCRYPT_KEY_LENGTH,
  };
  const key = await deriveKey(password, passwordParams);
  return { passwordHash: key.toString('hex'), passwordParams };
}

/**
 * Returns false for a wrong password or for parameters this process will not
 * run (unknown algorithm, absurd cost). A length mismatch must not throw:
 * `timingSafeEqual` throws when lengths differ, which would turn a corrupt
 * row into a 500 instead of a failed login.
 */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  if (!isRunnableScryptParams(record.passwordParams)) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await deriveKey(password, record.passwordParams);
  } catch {
    return false;
  }
  const stored = Buffer.from(record.passwordHash, 'hex');
  if (stored.length !== derived.length || stored.length === 0) {
    return false;
  }
  return timingSafeEqual(stored, derived);
}

export function isScryptPasswordParams(value: unknown): value is ScryptPasswordParams {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.algorithm === 'scrypt' &&
    typeof record.N === 'number' &&
    Number.isInteger(record.N) &&
    typeof record.r === 'number' &&
    Number.isInteger(record.r) &&
    typeof record.p === 'number' &&
    Number.isInteger(record.p) &&
    typeof record.salt === 'string' &&
    record.salt.length > 0 &&
    typeof record.keyLength === 'number' &&
    Number.isInteger(record.keyLength) &&
    record.keyLength > 0
  );
}

function isRunnableScryptParams(params: ScryptPasswordParams): boolean {
  if (!isScryptPasswordParams(params)) {
    return false;
  }
  if (params.N < 2 || (params.N & (params.N - 1)) !== 0) {
    return false;
  }
  if (params.r < 1 || params.p < 1 || params.keyLength < 16 || params.keyLength > 128) {
    return false;
  }
  const memoryBytes = 128 * params.N * params.r;
  return memoryBytes > 0 && memoryBytes <= SCRYPT_MAXMEM;
}

function deriveKey(password: string, params: ScryptPasswordParams): Promise<Buffer> {
  const salt = Buffer.from(params.salt, 'base64');
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(key);
      },
    );
  });
}
