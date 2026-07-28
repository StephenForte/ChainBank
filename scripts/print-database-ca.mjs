#!/usr/bin/env node
/**
 * Prints the Postgres peer (leaf) certificate for DATABASE_SSL_CA.
 *
 * Run only in the Render web Shell where DATABASE_URL is set:
 *   node scripts/print-database-ca.mjs
 *
 * Extraction uses openssl s_client without verification. That is acceptable
 * only on Render's trusted private path — untrusted networks can poison the pin.
 * The application runtime always verifies with rejectUnauthorized + leaf
 * fingerprint pinning against this PEM.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is not set in this shell.');
  }

  const url = new URL(databaseUrl);
  const port = url.port || '5432';
  const host = url.hostname;
  const target = `${host}:${port}`;

  process.stderr.write(`Connecting to ${target} via openssl …\n`);

  const client = spawnSync(
    'openssl',
    ['s_client', '-starttls', 'postgres', '-showcerts', '-connect', target],
    {
      input: '',
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  if (client.error !== undefined) {
    throw client.error;
  }

  const combined = `${client.stdout ?? ''}\n${client.stderr ?? ''}`;
  const match = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(combined);
  if (match === null) {
    throw new Error(
      'openssl did not return a certificate. Is openssl installed and is DATABASE_URL reachable?',
    );
  }

  const trustPem = `${match[0].trim()}\n`;
  const cert = new X509Certificate(trustPem);

  process.stderr.write('\n--- PEM (multi-line; pin this leaf as DATABASE_SSL_CA) ---\n');
  process.stdout.write(trustPem);

  process.stderr.write('\n--- PASTE THIS into Render DATABASE_SSL_CA ---\n');
  process.stderr.write('(one line; include the surrounding double quotes)\n');
  process.stdout.write(`${JSON.stringify(trustPem)}\n`);
  process.stderr.write(`\nSubject: ${cert.subject}\nIssuer:  ${cert.issuer}\n`);
  process.stderr.write(`Leaf fingerprint256: ${cert.fingerprint256}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
