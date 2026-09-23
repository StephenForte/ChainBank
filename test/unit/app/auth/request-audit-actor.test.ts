import { describe, expect, it } from 'vitest';
import {
  fundingAuditActor,
  recordedRequestActorType,
  requestAuditActor,
} from '../../../../src/app/auth/request-audit-actor.js';
import type { AuthenticatedActor } from '../../../../src/app/auth/authenticate-credential.js';

function actor(
  overrides: Partial<AuthenticatedActor> & Pick<AuthenticatedActor, 'credentialId'>,
): AuthenticatedActor {
  return {
    name: 'actor',
    role: 'operator',
    ...overrides,
  };
}

describe('requestAuditActor', () => {
  it('records a dashboard session as the user', () => {
    expect(
      requestAuditActor(
        actor({
          kind: 'dashboard_user',
          credentialId: 'user-1',
          userId: 'user-1',
          dashboardRole: 'admin',
          sessionId: 'session-1',
        }),
      ),
    ).toEqual({ type: 'dashboard_user', id: 'user-1' });
  });

  it('records a bearer credential as the credential', () => {
    expect(requestAuditActor(actor({ kind: 'api_credential', credentialId: 'cred-1' }))).toEqual({
      type: 'api_credential',
      id: 'cred-1',
    });
  });

  it('keeps an actor built before kind existed as an api credential', () => {
    expect(requestAuditActor(actor({ credentialId: 'cred-legacy' }))).toEqual({
      type: 'api_credential',
      id: 'cred-legacy',
    });
    expect(recordedRequestActorType(undefined)).toBe('api_credential');
  });
});

describe('fundingAuditActor', () => {
  it('keeps a scheduled reconciler as cron even when a session kind is supplied', () => {
    expect(
      fundingAuditActor({
        role: 'cron-reconciler',
        credentialId: 'wallet-reconciler',
        actorType: 'dashboard_user',
      }),
    ).toEqual({ type: 'cron', id: 'wallet-reconciler' });
  });

  it('records a request actor on the non-cron path', () => {
    expect(
      fundingAuditActor({
        role: 'operator',
        credentialId: 'user-1',
        actorType: 'dashboard_user',
      }),
    ).toEqual({ type: 'dashboard_user', id: 'user-1' });
    expect(fundingAuditActor({ role: 'operator', credentialId: 'cred-1' })).toEqual({
      type: 'api_credential',
      id: 'cred-1',
    });
  });
});
