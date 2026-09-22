import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import type { Role } from '../../domain/auth/roles.js';
import type { DashboardRole } from '../../domain/auth/users.js';
import { hashApiToken } from '../../shared/api-token.js';
import type { ApiCredentialRepository } from '../ports.js';

export interface AuthenticatedActor {
  readonly credentialId: string;
  readonly name: string;
  readonly role: Role;
  /**
   * Who presented the credential (C31). Bearer authentication sets
   * `api_credential`. A dashboard session sets `dashboard_user` plus `userId`.
   * Optional so actors constructed before the field existed still typecheck.
   */
  readonly kind?: 'api_credential' | 'dashboard_user';
  readonly userId?: string;
  readonly dashboardRole?: DashboardRole;
  /** Set only for a dashboard session, so password change can spare this row. */
  readonly sessionId?: string;
}

export interface AuthenticateCredentialDependencies {
  readonly apiCredentials: ApiCredentialRepository;
  readonly clock: Clock;
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (authorizationHeader === undefined || authorizationHeader.trim() === '') {
    throw new ChainBankError('AUTHENTICATION_REQUIRED', 'Authorization header is absent', {
      publicMessage: 'A bearer token is required.',
    });
  }
  const match = BEARER_PATTERN.exec(authorizationHeader.trim());
  const token = match?.[1];
  if (token === undefined) {
    throw new ChainBankError('AUTHENTICATION_REQUIRED', 'Authorization header is not a bearer token', {
      publicMessage: 'A bearer token is required.',
    });
  }
  return token;
}

/**
 * Resolves a presented token to an actor.
 *
 * Every rejection path returns the same public message so the response cannot
 * be used to distinguish an unknown token from a revoked or disabled one.
 */
export async function authenticateCredential(
  dependencies: AuthenticateCredentialDependencies,
  token: string,
): Promise<AuthenticatedActor> {
  const credential = await dependencies.apiCredentials.findByTokenHash(hashApiToken(token));

  if (credential === undefined) {
    throw new ChainBankError('INVALID_CREDENTIAL', 'No credential matches the presented token', {
      publicMessage: 'The supplied credential is not valid.',
    });
  }
  if (!credential.enabled || credential.revokedAt !== undefined) {
    throw new ChainBankError('CREDENTIAL_DISABLED', `Credential ${credential.id} is disabled or revoked`, {
      publicMessage: 'The supplied credential is not valid.',
      context: { credentialId: credential.id },
    });
  }

  // Usage tracking shares the request's fate on purpose: if the database cannot
  // record that a credential was used, the request should fail rather than
  // proceed unrecorded.
  await dependencies.apiCredentials.touchLastUsed(credential.id, dependencies.clock.now());

  return {
    kind: 'api_credential',
    credentialId: credential.id,
    name: credential.name,
    role: credential.role,
  };
}
