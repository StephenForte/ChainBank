import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Container } from '../container.js';
import { ChainBankError } from '../domain/errors.js';
import { hashApiToken } from '../shared/api-token.js';
import { notFoundBody, registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthentication } from './plugins/authentication.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerEnvironmentRoutes } from './routes/environments.js';
import { registerFundingOperationRoutes } from './routes/funding-operations.js';
import { registerFundingTransactionRoutes } from './routes/funding-transactions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTreasuryRoutes } from './routes/treasuries.js';
import { registerWalletRoutes } from './routes/wallets.js';
import type { AppInstance } from './types.js';

/** Requests carry no large payloads in this phase; a tight ceiling limits abuse. */
const BODY_LIMIT_BYTES = 32 * 1024;

const API_PATH_PREFIXES = ['/v1', '/health'];

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

export async function buildApp(container: Container): Promise<AppInstance> {
  const { config, logger } = container;
  const security = config.apiSecurity;
  if (security === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'API security configuration is required for the web role',
    );
  }

  const app = Fastify({
    loggerInstance: logger,
    // Request IDs are always generated here. A client-supplied header is not
    // trusted, so it cannot be used to forge or collide correlation IDs.
    requestIdHeader: false,
    genReqId: () => container.idGenerator.next(),
    bodyLimit: BODY_LIMIT_BYTES,
    // Trust exactly the configured number of proxy hops, never `true`. With
    // `true`, Fastify takes the left-most X-Forwarded-For entry, which any
    // client can set — letting a caller forge `request.ip` and so escape
    // IP-keyed rate limits and poison audit provenance.
    trustProxy: config.app.isHosted ? security.trustedProxyHops : false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: false,
      },
    },
  });

  await app.register(helmet, {
    // The dashboard is served from this origin and loads no third-party code.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: config.app.isHosted ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // Deny by default: with no configured origins, no cross-origin request is
  // permitted. The dashboard is same-origin in a deployed environment.
  await app.register(cors, {
    origin: security.corsAllowedOrigins.length === 0 ? false : [...security.corsAllowedOrigins],
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT'],
  });

  await app.register(rateLimit, {
    max: security.rateLimitMax,
    timeWindow: security.rateLimitWindowSeconds * 1000,
    keyGenerator: rateLimitKeyOf,
  });

  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

  registerErrorHandler(app);
  registerAuthentication(app, container);

  registerHealthRoutes(app, container);
  registerTreasuryRoutes(app, container);
  registerProjectRoutes(app, container);
  registerEnvironmentRoutes(app, container);
  registerWalletRoutes(app, container);
  registerFundingOperationRoutes(app, container);
  registerFundingTransactionRoutes(app, container);
  registerAdminRoutes(app, container);

  await registerDashboard(app);

  return app;
}

/**
 * Rate-limit bucket for a request (PRD §15.3: limits apply by credential).
 *
 * Derived from the presented bearer token rather than `request.actor`, because
 * rate limiting runs at `onRequest` while authentication is a route
 * `preHandler` — reading `request.actor` here would always be `undefined` and
 * silently degrade every limit to per-IP. Hashing keeps the raw token out of
 * the limiter's key store, and reuses the same digest the credential store
 * holds, so a token that is presented but invalid still gets a stable bucket
 * instead of sharing the caller's IP bucket.
 */
export function rateLimitKeyOf(request: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const authorization = request.headers.authorization;
  const token =
    typeof authorization === 'string' ? BEARER_PATTERN.exec(authorization.trim())?.[1] : undefined;
  return token === undefined ? `ip:${request.ip}` : `tok:${hashApiToken(token)}`;
}

/**
 * Serves the built dashboard, when one is present.
 *
 * A development run without a dashboard build still starts and serves the API;
 * the missing bundle degrades to a JSON 404 rather than a boot failure.
 */
async function registerDashboard(app: AppInstance): Promise<void> {
  const dashboardRoot = resolveDashboardRoot();

  if (dashboardRoot !== undefined) {
    await app.register(fastifyStatic, { root: dashboardRoot, wildcard: false, index: ['index.html'] });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApiPath = API_PATH_PREFIXES.some((prefix) => request.url.startsWith(prefix));

    // Client-side routes must resolve to the single-page app, but an unknown
    // API path has to stay a machine-readable 404.
    if (!isApiPath && request.method === 'GET' && dashboardRoot !== undefined) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send(notFoundBody(request.id));
  });
}

function resolveDashboardRoot(): string | undefined {
  // Resolved relative to the compiled file so the path holds whether the
  // process was started from the repository root or elsewhere.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../dashboard'), resolve(here, '../../../dist/dashboard')];
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')));
}
