/** Cookie name on the wire (C31). */
export const SESSION_COOKIE_NAME = 'chainbank_session';

/** Header the dashboard must send with a cookie. Lowercase, as Node presents it. */
export const SESSION_CSRF_HEADER = 'x-chainbank-session';

export const SESSION_CSRF_HEADER_VALUE = '1';

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined || cookieHeader.trim() === '') {
    return undefined;
  }

  let found: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key !== name || found !== undefined) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim();
    found = value === '' ? undefined : value;
  }
  return found;
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  return readCookie(cookieHeader, SESSION_COOKIE_NAME);
}

export function hasSessionCsrfHeader(value: string | string[] | undefined): boolean {
  return value === SESSION_CSRF_HEADER_VALUE;
}

/**
 * `Secure` is omitted when `secure` is false so a local http dashboard can
 * store the cookie. Hosted deployments pass true.
 */
export function serializeSessionCookie(
  token: string,
  options: { readonly maxAgeSeconds: number; readonly secure: boolean },
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Session token contains characters that would break a Set-Cookie header.');
  }
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    ...(options.secure ? ['Secure'] : []),
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  return attributes.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  return attributes.join('; ');
}
