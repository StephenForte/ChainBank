import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  assertValidPemCertificate,
  buildSslOptions,
  normalizePem,
} from '../../../src/infrastructure/db/client.js';

const sampleCa = readFileSync(new URL('../../fixtures/sample-ca.pem', import.meta.url), 'utf8');

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
    const ssl = buildSslOptions({
      url: 'postgres://localhost/db',
      poolMax: 1,
      useSsl: true,
      sslCertificateAuthority: sampleCa,
    });
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect(typeof ssl === 'object' && ssl !== null && 'ca' in ssl ? ssl.ca : undefined).toContain(
      'BEGIN CERTIFICATE',
    );
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

  it('rebuilds single-line and JSON-escaped PEMs into parseable certificates', () => {
    const escaped = JSON.stringify(sampleCa);
    const collapsed = sampleCa.replaceAll('\n', ' ');

    expect(() => assertValidPemCertificate(normalizePem(escaped))).not.toThrow();
    expect(() => assertValidPemCertificate(normalizePem(collapsed))).not.toThrow();
    expect(() => assertValidPemCertificate('not-a-cert')).toThrow(ChainBankError);
  });

  it('normalizes literal \\n sequences in PEM env values', () => {
    const normalized = normalizePem(sampleCa.replaceAll('\n', '\\n'));
    expect(normalized).toContain('-----BEGIN CERTIFICATE-----\n');
    expect(() => assertValidPemCertificate(normalized)).not.toThrow();
  });
});
