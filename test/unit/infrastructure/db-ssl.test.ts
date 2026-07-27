import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  assertValidPemCertificate,
  buildSslOptions,
  createPinnedCaCheckServerIdentity,
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

  it('pins the CA and replaces hostname checks (pg overwrites servername)', () => {
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
    expect(
      typeof ssl === 'object' && ssl !== null && 'checkServerIdentity' in ssl
        ? typeof ssl.checkServerIdentity
        : undefined,
    ).toBe('function');
    expect(typeof ssl === 'object' && ssl !== null && 'servername' in ssl).toBe(false);
  });

  it('accepts a peer certificate that exactly matches the pinned CA fingerprint', () => {
    const check = createPinnedCaCheckServerIdentity(normalizePem(sampleCa));
    const raw = new X509Certificate(normalizePem(sampleCa)).raw;
    expect(
      check('dpg-example-a', {
        raw,
        subject: { CN: 'chainbank-test' },
        issuer: {},
        valid_from: '',
        valid_to: '',
        fingerprint: '',
        fingerprint256: '',
        fingerprint512: '',
        serialNumber: '',
        bits: 0,
        exponent: '',
        pubkey: Buffer.alloc(0),
        asn1Curve: undefined,
        nistCurve: undefined,
        ext_key_usage: undefined,
        subjectaltname: undefined,
        infoAccess: undefined,
        ca: false,
      }),
    ).toBeUndefined();
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
