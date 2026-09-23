import type { Role } from '../../domain/auth/roles.js';
import type { AuthenticatedActor } from './authenticate-credential.js';

/** Kind stored on an audit row for an authenticated request (TX.43). */
export type RequestAuditActorType = 'api_credential' | 'dashboard_user';

export interface RequestAuditActor {
  readonly type: RequestAuditActorType;
  readonly id: string;
}

/**
 * Audit attribution for the actor that authenticated this request.
 *
 * A dashboard session is `dashboard_user` and its id is the user id, which the
 * session actor already stores as `credentialId`. A bearer credential is
 * `api_credential`. Actors built before `kind` existed stay `api_credential`.
 */
export function requestAuditActor(actor: AuthenticatedActor): RequestAuditActor {
  return {
    type: actor.kind ?? 'api_credential',
    id: actor.credentialId,
  };
}

/** `api_credential` when a caller does not name a request actor kind. */
export function recordedRequestActorType(
  actorType: RequestAuditActorType | undefined,
): RequestAuditActorType {
  return actorType ?? 'api_credential';
}

export type FundingAuditActorType = RequestAuditActorType | 'cron';

/**
 * Scheduled reconciliation stays `cron` even if a request actor type is also
 * supplied. Every other caller records the request actor kind.
 */
export function fundingAuditActor(input: {
  readonly role: Role;
  readonly credentialId: string;
  readonly actorType?: RequestAuditActorType;
}): { readonly type: FundingAuditActorType; readonly id: string } {
  if (input.role === 'cron-reconciler') {
    return { type: 'cron', id: input.credentialId };
  }
  return {
    type: recordedRequestActorType(input.actorType),
    id: input.credentialId,
  };
}
