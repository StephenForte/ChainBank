import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppInstance } from '../types.js';
import {
  authenticateCredential,
  extractBearerToken,
  type AuthenticatedActor,
} from '../../app/auth/authenticate-credential.js';
import type { Container } from '../../container.js';

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
 * Authenticates a bearer token and attaches the resolved actor.
 *
 * This establishes identity only. Every route's permission check happens in the
 * application service, so a handler registered without this hook cannot
 * accidentally become an authorized path.
 */
export function registerAuthentication(app: AppInstance, container: Container): void {
  const dependencies = {
    apiCredentials: container.repositories.apiCredentials,
    clock: container.clock,
  };

  app.decorate('authenticate', async function authenticate(request: FastifyRequest): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    request.actor = await authenticateCredential(dependencies, token);
  });
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
