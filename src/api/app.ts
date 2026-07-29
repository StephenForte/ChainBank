import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Container } from '../container.js';
import { ChainBankError } from '../domain/errors.js';
import { notFoundBody, registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthentication } from './plugins/authentication.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTreasuryRoutes } from './routes/treasuries.js';
import { registerWalletRoutes } from './routes/wallets.js';
import type { AppInstance } from './types.js';

/** Requests carry no large payloads in this phase; a tight ceiling limits abuse. */
const BODY_LIMIT_BYTES = 32 * 1024;

const API_PATH_PREFIXES = ['/v1', '/health'];

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
    // Render terminates TLS at its proxy, so the forwarded client address is
    // authoritative there and only there.
    trustProxy: config.app.isHosted,
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
    // Limits apply per credential where one is presented, falling back to the
    // source address for unauthenticated traffic.
    keyGenerator: (request) => request.actor?.credentialId ?? request.ip,
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
  registerWalletRoutes(app, container);
  registerAdminRoutes(app, container);

  await registerDashboard(app);

  return app;
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
