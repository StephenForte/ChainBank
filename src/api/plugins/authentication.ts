import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppInstance } from '../types.js';
import {
  authenticateCredential,
  extractBearerToken,
  type AuthenticatedActor,
} from '../../app/auth/authenticate-credential.js';
import { resolveSession } from '../../app/auth/resolve-session.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import {
  hasSessionCsrfHeader,
  readSessionToken,
  serializeSessionCookie,
  SESSION_CSRF_HEADER,
} from '../cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the authentication hook. Absent on public routes. */
    actor?: AuthenticatedActor;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
  }
}

/**
 * Authenticates a request and attaches the resolved actor.
 *
 * If an Authorization header is present, it is the only credential considered.
 * A valid session cookie is not a fallback for a bad bearer token. The cookie
 * is consulted only when that header is absent, and only together with
 * `X-ChainBank-Session: 1` (C31).
 */
export function registerAuthentication(app: AppInstance, container: Container): void {
  const credentialDependencies = {
    apiCredentials: container.repositories.apiCredentials,
    clock: container.clock,
  };
  const security = container.config.apiSecurity;

  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const authorization = request.headers.authorization;
      if (
        Array.isArray(authorization) ||
        (typeof authorization === 'string' && authorization.trim() !== '')
      ) {
        const token = extractBearerToken(typeof authorization === 'string' ? authorization : undefined);
        request.actor = await authenticateCredential(credentialDependencies, token);
        return;
      }

      const sessionToken = readSessionToken(cookieHeader(request));
      if (sessionToken === undefined) {
        throw new ChainBankError('AUTHENTICATION_REQUIRED', 'Authorization header is absent', {
          publicMessage: 'A bearer token is required.',
        });
      }
      if (!hasSessionCsrfHeader(request.headers[SESSION_CSRF_HEADER])) {
        throw new ChainBankError(
          'AUTHENTICATION_REQUIRED',
          'Session cookie was presented without the session header',
          {
            publicMessage: 'A bearer token is required.',
          },
        );
      }
      if (
        security === undefined ||
        container.repositories.dashboardUsers === undefined ||
        container.repositories.dashboardSessions === undefined
      ) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          'Dashboard session authentication is not configured',
          {
            publicMessage: 'The service is misconfigured.',
          },
        );
      }

      request.actor = await resolveSession(
        {
          users: container.repositories.dashboardUsers,
          sessions: container.repositories.dashboardSessions,
        },
        {
          sessionToken,
          now: container.clock.now(),
          idleTtlSeconds: security.sessionIdleTtlSeconds,
        },
      );

      if (request.routeOptions.url !== '/v1/auth/logout') {
        void reply.header(
          'set-cookie',
          serializeSessionCookie(sessionToken, {
            maxAgeSeconds: security.sessionIdleTtlSeconds,
            secure: container.config.app.isHosted,
          }),
        );
      }
    },
  );
}

function cookieHeader(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie;
  return typeof cookie === 'string' ? cookie : undefined;
}

/**
 * Reads the actor a route's authentication hook established. Throwing here
 * would indicate a wiring mistake rather than a client error.
 */
export function requireActor(request: FastifyRequest): AuthenticatedActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('Route handler requires an authenticated actor but no authentication hook ran.');
  }
  return actor;
}
