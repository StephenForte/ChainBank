import { describe, expect, it, vi } from 'vitest';
import {
  authorizeScope,
  hasEnvironmentScope,
  hasProjectScope,
  resolveReadableProjectIds,
  type AuthorizeScopeDependencies,
} from '../../../../src/app/auth/authorize-scope.js';
import type { CredentialScope } from '../../../../src/app/ports.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import type { Role } from '../../../../src/domain/auth/roles.js';

const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENV_A1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ENV_A2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const projectWideScope: CredentialScope = {
  id: '1',
  credentialId: CREDENTIAL_ID,
  projectId: PROJECT_A,
  environmentId: undefined,
  createdAt: new Date(),
};

const envScope: CredentialScope = {
  id: '2',
  credentialId: CREDENTIAL_ID,
  projectId: PROJECT_A,
  environmentId: ENV_A1,
  createdAt: new Date(),
};

function deps(scopes: readonly CredentialScope[]): AuthorizeScopeDependencies {
  return {
    credentialScopes: {
      listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
      insert: vi.fn(),
    },
  };
}

describe('authorizeScope authorization matrix', () => {
  const roles: readonly Role[] = [
    'operator',
    'read-only',
    'project-service',
    'cron-treasury-monitor',
    'cron-reconciler',
  ];

  it('allows operator read and mutate for any project', async () => {
    for (const action of ['read', 'mutate'] as const) {
      await expect(
        authorizeScope(deps([]), {
          role: 'operator',
          credentialId: CREDENTIAL_ID,
          action,
          projectId: PROJECT_B,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('allows read-only read for all projects and denies mutate', async () => {
    await expect(
      authorizeScope(deps([]), {
        role: 'read-only',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_B,
      }),
    ).resolves.toBeUndefined();

    await expect(
      authorizeScope(deps([]), {
        role: 'read-only',
        credentialId: CREDENTIAL_ID,
        action: 'mutate',
        projectId: PROJECT_B,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });

  it('denies cron roles for read and mutate', async () => {
    for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
      for (const action of ['read', 'mutate'] as const) {
        await expect(
          authorizeScope(deps([projectWideScope]), {
            role,
            credentialId: CREDENTIAL_ID,
            action,
            projectId: PROJECT_A,
          }),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      }
    }
  });

  it('denies project-service mutate even when scoped', async () => {
    await expect(
      authorizeScope(deps([projectWideScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'mutate',
        projectId: PROJECT_A,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });

  it('allows project-service fund when scoped and denies read-only fund', async () => {
    await expect(
      authorizeScope(deps([projectWideScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'fund',
        projectId: PROJECT_A,
        environmentId: ENV_A2,
      }),
    ).resolves.toBeUndefined();

    await expect(
      authorizeScope(deps([]), {
        role: 'read-only',
        credentialId: CREDENTIAL_ID,
        action: 'fund',
        projectId: PROJECT_A,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });

  it('denies project-service fund when out of scope', async () => {
    await expect(
      authorizeScope(deps([envScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'fund',
        projectId: PROJECT_A,
        environmentId: ENV_A2,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('denies project-service read with no scope rows', async () => {
    await expect(
      authorizeScope(deps([]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_A,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('allows project-service read when project-wide scope matches', async () => {
    await expect(
      authorizeScope(deps([projectWideScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_A,
        environmentId: ENV_A2,
      }),
    ).resolves.toBeUndefined();
  });

  it('allows project-service project read with env-specific scope', async () => {
    await expect(
      authorizeScope(deps([envScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_A,
      }),
    ).resolves.toBeUndefined();
  });

  it('denies project-service read for out-of-scope project', async () => {
    await expect(
      authorizeScope(deps([envScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_B,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('denies project-service read for wrong environment with env-specific scope', async () => {
    await expect(
      authorizeScope(deps([envScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_A,
        environmentId: ENV_A2,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('covers every role in the matrix for read attempts', async () => {
    const expectations: Record<Role, 'allow' | 'deny'> = {
      operator: 'allow',
      'read-only': 'allow',
      'project-service': 'allow',
      'cron-treasury-monitor': 'deny',
      'cron-reconciler': 'deny',
    };

    for (const role of roles) {
      const run = authorizeScope(deps([projectWideScope]), {
        role,
        credentialId: CREDENTIAL_ID,
        action: 'read',
        projectId: PROJECT_A,
      });
      if (expectations[role] === 'allow') {
        await expect(run).resolves.toBeUndefined();
      } else {
        await expect(run).rejects.toBeInstanceOf(ChainBankError);
      }
    }
  });
});

describe('hasProjectScope / hasEnvironmentScope', () => {
  it('matches project-wide and env-specific rows', () => {
    expect(hasProjectScope([envScope], PROJECT_A)).toBe(true);
    expect(hasProjectScope([envScope], PROJECT_B)).toBe(false);
    expect(hasEnvironmentScope([projectWideScope], PROJECT_A, ENV_A1)).toBe(true);
    expect(hasEnvironmentScope([envScope], PROJECT_A, ENV_A1)).toBe(true);
    expect(hasEnvironmentScope([envScope], PROJECT_A, ENV_A2)).toBe(false);
  });
});

describe('resolveReadableProjectIds', () => {
  it('returns undefined for unrestricted roles', async () => {
    for (const role of ['operator', 'read-only'] as const) {
      await expect(
        resolveReadableProjectIds(deps([envScope]), { role, credentialId: CREDENTIAL_ID }),
      ).resolves.toBeUndefined();
    }
  });

  it('returns empty list for project-service without scopes', async () => {
    await expect(
      resolveReadableProjectIds(deps([]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
      }),
    ).resolves.toEqual([]);
  });

  it('returns distinct project ids for project-service', async () => {
    await expect(
      resolveReadableProjectIds(deps([envScope, projectWideScope]), {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
      }),
    ).resolves.toEqual([PROJECT_A]);
  });
});
