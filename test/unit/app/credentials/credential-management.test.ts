import { describe, expect, it, vi } from 'vitest';
import { listCredentials } from '../../../../src/app/credentials/list-credentials.js';
import { mutateCredential } from '../../../../src/app/credentials/mutate-credential.js';
import type {
  ApiCredentialRepository,
  ApiCredentialSummary,
  AuditEventRepository,
} from '../../../../src/app/ports.js';
import { ROLES, type Role } from '../../../../src/domain/auth/roles.js';
import { createFixedClock } from '../../../support/clock.js';

const now = new Date('2026-07-30T12:00:00.000Z');
const clock = createFixedClock(now);

const targetCredential: ApiCredentialSummary = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'project-acme',
  role: 'project-service',
  tokenPrefix: 'cb_abc123456',
  enabled: true,
  revokedAt: undefined,
  lastUsedAt: new Date('2026-07-29T10:00:00.000Z'),
  createdAt: new Date('2026-07-28T08:00:00.000Z'),
};

const operatorCredentialId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function buildRepository(overrides: Partial<ApiCredentialRepository> = {}): ApiCredentialRepository {
  return {
    findByTokenHash: vi.fn(),
    findById: vi.fn(() => Promise.resolve(targetCredential)),
    list: vi.fn(() => Promise.resolve({ items: [targetCredential], total: 1 })),
    disable: vi.fn(() =>
      Promise.resolve({
        ...targetCredential,
        enabled: false,
      }),
    ),
    revoke: vi.fn(() =>
      Promise.resolve({
        ...targetCredential,
        enabled: false,
        revokedAt: now,
      }),
    ),
    touchLastUsed: vi.fn(),
    ...overrides,
  };
}

function buildAuditEvents(): AuditEventRepository {
  return { record: vi.fn(() => Promise.resolve(undefined)) };
}

describe('listCredentials authorization', () => {
  const nonOperatorRoles = ROLES.filter((role): role is Role => role !== 'operator');

  it.each(nonOperatorRoles.map((role) => [role] as const))(
    'denies %s from listing credentials',
    async (role) => {
      await expect(
        listCredentials({ apiCredentials: buildRepository() }, { role, limit: 50, offset: 0 }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    },
  );

  it('allows operator to list credentials', async () => {
    const apiCredentials = buildRepository();
    const page = await listCredentials({ apiCredentials }, { role: 'operator', limit: 10, offset: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(apiCredentials.list).toHaveBeenCalledWith({ limit: 10, offset: 0 });
  });

  it('returns summaries without token_hash fields', async () => {
    const page = await listCredentials(
      { apiCredentials: buildRepository() },
      { role: 'operator', limit: 50, offset: 0 },
    );

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('tokenHash');
    expect(page.items[0]?.tokenPrefix).toBe('cb_abc123456');
  });
});

describe('mutateCredential authorization', () => {
  const mutateRoles: readonly Role[] = [
    'read-only',
    'project-service',
    'cron-treasury-monitor',
    'cron-reconciler',
  ];

  it.each(mutateRoles.map((role) => [role] as const))('denies %s from mutating credentials', async (role) => {
    await expect(
      mutateCredential(
        { apiCredentials: buildRepository(), auditEvents: buildAuditEvents(), clock },
        {
          role,
          credentialId: targetCredential.id,
          actorCredentialId: operatorCredentialId,
          action: 'disable',
          operationId: 'req-1',
          sourceIp: '127.0.0.1',
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });

  it.each(['disable', 'revoke'] as const)('allows operator to %s a credential', async (action) => {
    const apiCredentials = buildRepository();
    const auditEvents = buildAuditEvents();

    const result = await mutateCredential(
      { apiCredentials, auditEvents, clock },
      {
        role: 'operator',
        credentialId: targetCredential.id,
        actorCredentialId: operatorCredentialId,
        action,
        operationId: 'req-2',
        sourceIp: undefined,
      },
    );

    expect(result.enabled).toBe(false);
    if (action === 'disable') {
      expect(apiCredentials.disable).toHaveBeenCalledWith(targetCredential.id, now);
      expect(auditEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'credential.disabled',
          actorId: operatorCredentialId,
          entityId: targetCredential.id,
        }),
      );
    } else {
      expect(apiCredentials.revoke).toHaveBeenCalledWith(targetCredential.id, now);
      expect(result.revokedAt).toEqual(now);
      expect(auditEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'credential.revoked',
          actorId: operatorCredentialId,
          entityId: targetCredential.id,
        }),
      );
    }
  });
});

describe('mutateCredential guards', () => {
  it('refuses self-disable to prevent operator lockout', async () => {
    await expect(
      mutateCredential(
        {
          apiCredentials: buildRepository(),
          auditEvents: buildAuditEvents(),
          clock,
        },
        {
          role: 'operator',
          credentialId: operatorCredentialId,
          actorCredentialId: operatorCredentialId,
          action: 'disable',
          operationId: 'req-3',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_SELF_MUTATION_DENIED',
      publicMessage: 'You cannot disable or revoke the credential you are currently using.',
    });
  });

  it('refuses self-revoke to prevent operator lockout', async () => {
    await expect(
      mutateCredential(
        {
          apiCredentials: buildRepository(),
          auditEvents: buildAuditEvents(),
          clock,
        },
        {
          role: 'operator',
          credentialId: operatorCredentialId,
          actorCredentialId: operatorCredentialId,
          action: 'revoke',
          operationId: 'req-4',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_SELF_MUTATION_DENIED' });
  });

  it('returns not found when the credential id does not exist', async () => {
    const apiCredentials = buildRepository({
      findById: vi.fn(() => Promise.resolve(undefined)),
    });

    await expect(
      mutateCredential(
        { apiCredentials, auditEvents: buildAuditEvents(), clock },
        {
          role: 'operator',
          credentialId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          actorCredentialId: operatorCredentialId,
          action: 'revoke',
          operationId: 'req-5',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });
  });
});

describe('mutateCredential audit metadata', () => {
  it('records previous and next state with the acting credential', async () => {
    const auditEvents = buildAuditEvents();

    await mutateCredential(
      { apiCredentials: buildRepository(), auditEvents, clock },
      {
        role: 'operator',
        credentialId: targetCredential.id,
        actorCredentialId: operatorCredentialId,
        action: 'revoke',
        operationId: 'req-6',
        sourceIp: '10.0.0.5',
      },
    );

    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'api_credential',
        actorId: operatorCredentialId,
        entityType: 'api_credential',
        requestId: 'req-6',
        sourceIp: '10.0.0.5',
      }),
    );
    const auditCall = vi.mocked(auditEvents.record).mock.calls[0]?.[0];
    expect(auditCall?.metadata).toMatchObject({
      tokenPrefix: targetCredential.tokenPrefix,
      previous: { enabled: true, revokedAt: null },
      next: { enabled: false, revokedAt: now.toISOString() },
    });
  });
});
