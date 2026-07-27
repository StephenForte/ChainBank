import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import { buildSslOptions, normalizePem } from '../../../src/infrastructure/db/client.js';

describe('buildSslOptions', () => {
  it('disables TLS when useSsl is false', () => {
    expect(
      buildSslOptions({
        url: 'postgres://localhost/db',
        poolMax: 1,
        useSsl: false,
        sslCertificateAuthority: undefined,
      }),
    ).toBe(false);
  });

  it('always verifies certificates when TLS is enabled', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const ssl = buildSslOptions({
      url: 'postgres://localhost/db',
      poolMax: 1,
      useSsl: true,
      sslCertificateAuthority: ca,
    });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca });
  });

  it('refuses to enable TLS without a CA instead of disabling verification', () => {
    expect(() =>
      buildSslOptions({
        url: 'postgres://localhost/db',
        poolMax: 1,
        useSsl: true,
        sslCertificateAuthority: undefined,
      }),
    ).toThrow(ChainBankError);
  });

  it('normalizes literal \\n sequences in PEM env values', () => {
    expect(normalizePem('-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----')).toBe(
      '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
    );
  });
});
