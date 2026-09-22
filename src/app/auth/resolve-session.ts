import type { AuthenticatedActor } from './authenticate-credential.js';
import { hashSessionToken } from '../../domain/auth/session-token.js';
import { apiRoleForDashboardRole } from '../../domain/auth/users.js';
import { ChainBankError } from '../../domain/errors.js';
import type { DashboardSessionRepository, DashboardUserRepository } from '../ports.js';

const INVALID_SESSION_MESSAGE = 'The supplied credential is not valid.';

export interface ResolveSessionDependencies {
  readonly users: DashboardUserRepository;
  readonly sessions: DashboardSessionRepository;
}

export interface ResolveSessionInput {
  readonly sessionToken: string;
  readonly now: Date;
  readonly idleTtlSeconds: number;
}

/**
 * Resolves a raw session token to an actor.
 *
 * Expired and revoked rows are rejected without writing `last_seen_at`, so a
 * dead session cannot be brought back by presenting it again.
 */
export async function resolveSession(
  dependencies: ResolveSessionDependencies,
  input: ResolveSessionInput,
): Promise<AuthenticatedActor> {
  const session = await dependencies.sessions.findByTokenHash(hashSessionToken(input.sessionToken));
  const idleCutoff = new Date(input.now.getTime() - input.idleTtlSeconds * 1000);
  if (
    session === undefined ||
    session.revokedAt !== undefined ||
    session.expiresAt.getTime() <= input.now.getTime() ||
    session.lastSeenAt.getTime() <= idleCutoff.getTime()
  ) {
    throw invalidSession();
  }

  const user = await dependencies.users.findById(session.userId);
  if (user === undefined || !user.enabled) {
    throw invalidSession();
  }

  const slid = await dependencies.sessions.touchIfActive({
    id: session.id,
    now: input.now,
    idleCutoff,
  });
  if (!slid) {
    throw invalidSession();
  }

  return {
    kind: 'dashboard_user',
    credentialId: user.id,
    name: user.displayName,
    role: apiRoleForDashboardRole(user.role),
    userId: user.id,
    dashboardRole: user.role,
    sessionId: session.id,
  };
}

function invalidSession(): ChainBankError {
  return new ChainBankError('INVALID_CREDENTIAL', 'Dashboard session is missing, expired, or revoked', {
    publicMessage: INVALID_SESSION_MESSAGE,
  });
}
