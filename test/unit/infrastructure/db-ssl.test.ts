import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  assertValidPemCertificate,
  buildSslOptions,
  createPinnedCaCheckServerIdentity,
  describeDatabaseTlsPin,
  normalizePem,
} from '../../../src/infrastructure/db/client.js';

const sampleCa = readFileSync(new URL('../../fixtures/sample-ca.pem', import.meta.url), 'utf8');
const otherCa = readFileSync(new URL('../../fixtures/sample-other-ca.pem', import.meta.url), 'utf8');

function peerCert(raw: Buffer | undefined): PeerCertificate {
  return {
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
  } as unknown as PeerCertificate;
}

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
    expect(check('dpg-example-a', peerCert(raw))).toBeUndefined();
  });

  it('rejects a peer certificate whose fingerprint does not match the leaf pin', () => {
    const check = createPinnedCaCheckServerIdentity(normalizePem(sampleCa));
    const otherRaw = new X509Certificate(normalizePem(otherCa)).raw;
    const result = check('dpg-example-a', peerCert(otherRaw));
    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toMatch(/fingerprint does not match/i);
  });

  it('rejects a peer certificate missing raw bytes', () => {
    const check = createPinnedCaCheckServerIdentity(normalizePem(sampleCa));
    const result = check('dpg-example-a', peerCert(undefined));
    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toMatch(/missing raw bytes/i);
  });

  it('ignores hostname when deciding acceptance (leaf pin is sole identity rule)', () => {
    const check = createPinnedCaCheckServerIdentity(normalizePem(sampleCa));
    const raw = new X509Certificate(normalizePem(sampleCa)).raw;
    expect(check('totally-unrelated.example', peerCert(raw))).toBeUndefined();
    expect(check('dpg-example-a', peerCert(new X509Certificate(normalizePem(otherCa)).raw))).toBeInstanceOf(
      Error,
    );
  });

  it('describes leaf pin mode with CA fingerprint only (never PEM body)', () => {
    const diagnostics = describeDatabaseTlsPin(sampleCa);
    expect(diagnostics).toEqual({
      databaseTlsPinMode: 'leaf',
      databaseTlsCaFingerprint256: new X509Certificate(normalizePem(sampleCa)).fingerprint256,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('BEGIN CERTIFICATE');
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
