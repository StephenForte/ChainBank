import { describe, expect, it } from 'vitest';
import { buildApp, rateLimitKeyOf } from '../../../src/api/app.js';
import type { AppInstance } from '../../../src/api/types.js';
import { loadConfig } from '../../../src/config/index.js';
import { createTrustProxy } from '../../../src/config/trusted-proxy.js';
import type { Container } from '../../../src/container.js';
import { createLogger } from '../../../src/observability/logger.js';
import { validWebEnv } from '../../support/env.js';

/**
 * CVE-2026-16732 regression: a hop-only predicate trusts every socket peer, so
 * a direct caller can set X-Forwarded-For and replace request.ip. These cases
 * fail if `address` is unused.
 */
describe('createTrustProxy', () => {
  it('accepts a peer inside the set and rejects one outside it at the same hop', () => {
    const trust = createTrustProxy(['10.0.0.0/8']);
    expect(trust('10.9.8.7', 0)).toBe(true);
    expect(trust('203.0.113.4', 0)).toBe(false);
    expect(trust('not-an-ip', 0)).toBe(false);
  });

  it('matches an IPv4-mapped socket against the IPv4 range', () => {
    const trust = createTrustProxy(['10.0.0.0/8']);
    expect(trust('::ffff:10.1.2.3', 0)).toBe(true);
    expect(trust('::ffff:203.0.113.4', 0)).toBe(false);
  });

  it('rejects an empty allowlist', () => {
    expect(() => createTrustProxy([])).toThrow(/empty list/i);
  });
});

describe('hosted request.ip', () => {
  it('honours X-Forwarded-For from a trusted peer and ignores it from any other peer', async () => {
    const app = await buildHostedApp('10.0.0.0/8');

    const trusted = await app.inject({
      method: 'GET',
      url: '/__trust-proxy',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json()).toEqual({ ip: '203.0.113.10', key: 'ip:203.0.113.10' });

    const spoofed = await app.inject({
      method: 'GET',
      url: '/__trust-proxy',
      remoteAddress: '198.51.100.20',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.json()).toEqual({ ip: '198.51.100.20', key: 'ip:198.51.100.20' });

    await app.close();
  });

  it('keeps distinct clients behind the trusted proxy in distinct rate-limit buckets', async () => {
    const app = await buildHostedApp('10.0.0.0/8');
    const first = await observe(app, '10.0.0.5', '203.0.113.10');
    const second = await observe(app, '10.0.0.5', '203.0.113.11');

    expect(first).toEqual({ ip: '203.0.113.10', key: 'ip:203.0.113.10' });
    expect(second).toEqual({ ip: '203.0.113.11', key: 'ip:203.0.113.11' });
    expect(first.key).not.toBe(second.key);

    await app.close();
  });

  it('honours X-Forwarded-For when the trusted peer is IPv4-mapped', async () => {
    const app = await buildHostedApp('10.0.0.0/8');
    const observed = await observe(app, '::ffff:10.0.0.5', '203.0.113.8');
    expect(observed.ip).toBe('203.0.113.8');
    await app.close();
  });
});

describe('local request.ip', () => {
  it('ignores X-Forwarded-For when the process is not hosted', async () => {
    const config = loadConfig({ serviceRole: 'web', env: validWebEnv() });
    const app = await buildApp(stubContainer(config));
    app.get('/__trust-proxy', (request) => ({
      ip: request.ip,
      key: rateLimitKeyOf(request),
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/__trust-proxy',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '10.0.0.5', key: 'ip:10.0.0.5' });
    await app.close();
  });
});

async function buildHostedApp(cidrs: string): Promise<AppInstance> {
  const config = loadConfig({
    serviceRole: 'web',
    env: validWebEnv({
      CHAINBANK_ENVIRONMENT: 'hosted-development',
      DATABASE_SSL: 'false',
      TRUSTED_PROXY_CIDRS: cidrs,
    }),
  });
  const app = await buildApp(stubContainer(config));
  app.get('/__trust-proxy', (request) => ({
    ip: request.ip,
    key: rateLimitKeyOf(request),
  }));
  return app;
}

async function observe(
  app: AppInstance,
  remoteAddress: string,
  forwardedFor: string,
): Promise<{ ip: string; key: string }> {
  const response = await app.inject({
    method: 'GET',
    url: '/__trust-proxy',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ ip: string; key: string }>();
}

function stubContainer(config: ReturnType<typeof loadConfig>): Container {
  return {
    config,
    logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    clock: { now: () => new Date('2026-09-21T00:00:00.000Z') },
    idGenerator: { next: () => 'req-trust-proxy' },
    repositories: {},
  } as unknown as Container;
}
