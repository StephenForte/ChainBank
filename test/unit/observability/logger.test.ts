import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/observability/logger.js';

function collectLogs(): { stream: Writable; lines: () => unknown[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}

describe('createLogger redaction', () => {
  it('redacts credential-shaped fields from structured logs', async () => {
    const sink = collectLogs();
    const logger = createLogger({
      level: 'info',
      serviceRole: 'web',
      environment: 'local',
      destination: sink.stream,
    });

    logger.info(
      {
        apiKey: 're_live_secret',
        privateKey: '0xabc',
        DATABASE_URL: 'postgres://user:pass@host/db',
        nested: { token: 'cb_should_be_redacted', rpcUrl: 'https://secret.rpc' },
      },
      'sensitive payload',
    );

    // pino writes asynchronously through the destination stream.
    await new Promise((resolve) => setImmediate(resolve));

    const [entry] = sink.lines() as Array<Record<string, unknown>>;
    expect(entry).toBeDefined();
    expect(entry?.apiKey).toBe('[redacted]');
    expect(entry?.privateKey).toBe('[redacted]');
    expect(entry?.DATABASE_URL).toBe('[redacted]');
    expect((entry?.nested as Record<string, unknown>).token).toBe('[redacted]');
    expect((entry?.nested as Record<string, unknown>).rpcUrl).toBe('[redacted]');
  });
});
