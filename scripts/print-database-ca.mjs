#!/usr/bin/env node
/**
 * Prints the Postgres TLS certificate chain for DATABASE_SSL_CA.
 *
 * Run in the Render web Shell where DATABASE_URL is set:
 *   node scripts/print-database-ca.mjs
 *
 * Verification is disabled only for this one-shot extraction so a self-signed
 * server cert can be captured. The application runtime always verifies.
 */
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/**
 * @param {import('tls').DetailedPeerCertificate | undefined} peer
 * @returns {string[]}
 */
function collectPemChain(peer) {
  /** @type {string[]} */
  const pems = [];
  let current = peer;
  while (current !== undefined && current.raw !== undefined) {
    const cert = new X509Certificate(current.raw);
    pems.push(cert.toString());
    if (current === current.issuerCertificate) {
      break;
    }
    current = current.issuerCertificate;
  }
  return pems;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is not set in this shell.');
  }

  const url = new URL(databaseUrl);
  const port = Number(url.port || '5432');
  const host = url.hostname;

  process.stderr.write(`Connecting to ${host}:${String(port)} …\n`);

  const socket = net.connect({ host, port });
  await once(socket, 'connect');
  socket.write(SSL_REQUEST);

  const [response] = /** @type {[Buffer]} */ (await once(socket, 'data'));
  if (response.toString('utf8') !== 'S') {
    throw new Error('PostgreSQL server refused TLS (expected SSLResponse "S").');
  }

  const secure = tls.connect({
    socket,
    servername: host,
    // Extraction only — never copy this into the application client.
    rejectUnauthorized: false,
  });
  await once(secure, 'secureConnect');

  const peer = secure.getPeerCertificate(true);
  if (peer === undefined || peer.raw === undefined) {
    throw new Error('Server did not present a certificate.');
  }

  const chain = collectPemChain(peer);
  // Prefer the issuer/root when present; for self-signed leaf === root.
  const trustPem = chain[chain.length - 1] ?? new X509Certificate(peer.raw).toString();

  process.stderr.write(`\nChain length: ${String(chain.length)}\n`);
  process.stderr.write('--- PEM (multi-line; trust this as DATABASE_SSL_CA) ---\n');
  process.stdout.write(trustPem.endsWith('\n') ? trustPem : `${trustPem}\n`);

  process.stderr.write('\n--- PASTE THIS into Render DATABASE_SSL_CA ---\n');
  process.stderr.write('(one line; include the surrounding double quotes)\n');
  process.stdout.write(`${JSON.stringify(trustPem)}\n`);
  process.stderr.write(
    `\nSubject: ${peer.subject?.CN ?? JSON.stringify(peer.subject)}\n` +
      `Issuer:  ${peer.issuer?.CN ?? JSON.stringify(peer.issuer)}\n` +
      `Fingerprint: ${new X509Certificate(peer.raw).fingerprint256}\n`,
  );

  secure.end();
  socket.destroy();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
