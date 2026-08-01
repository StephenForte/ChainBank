import { describe, expect, it, vi } from 'vitest';
import { listEnvironments } from '../../../../src/app/projects/list-environments.js';
import type {
  CredentialScope,
  CredentialScopeRepository,
  Environment,
  EnvironmentRepository,
  Project,
  ProjectRepository,
} from '../../../../src/app/ports.js';
import { DEFAULT_PAGE_LIMIT, parsePageLimit, parsePageOffset } from '../../../../src/api/pagination.js';

const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENV_A1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ENV_A2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ENV_B1 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CREDENTIAL_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const now = new Date('2026-07-28T12:00:00.000Z');
const later = new Date('2026-07-28T13:00:00.000Z');

const projectA: Project = {
  id: PROJECT_A,
  slug: 'fortel2',
  name: 'ForteL2',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const projectB: Project = {
  id: PROJECT_B,
  slug: 'other',
  name: 'Other',
  enabled: true,
  createdAt: later,
  updatedAt: later,
};

const environmentA1: Environment = {
  id: ENV_A1,
  projectId: PROJECT_A,
  slug: 'dev',
  name: 'Development',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const environmentA2: Environment = {
  id: ENV_A2,
  projectId: PROJECT_A,
  slug: 'staging',
  name: 'Staging',
  enabled: true,
  createdAt: later,
  updatedAt: later,
};

const environmentB1: Environment = {
  id: ENV_B1,
  projectId: PROJECT_B,
  slug: 'prod',
  name: 'Production',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

function scopeRepo(scopes: readonly CredentialScope[]): CredentialScopeRepository {
  return {
    listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
    insert: vi.fn(),
  };
}

function buildDeps(options: {
  readonly projects?: Partial<ProjectRepository>;
  readonly environments?: Partial<EnvironmentRepository>;
  readonly scopes?: readonly CredentialScope[];
}) {
  const projects: ProjectRepository = {
    insert: vi.fn(),
    findById: vi.fn((id: string) =>
      Promise.resolve(id === PROJECT_A ? projectA : id === PROJECT_B ? projectB : undefined),
    ),
    findBySlug: vi.fn(),
    list: vi.fn(),
    listByIds: vi.fn(),
    setEnabled: vi.fn(),
    ...options.projects,
  };
  const environments: EnvironmentRepository = {
    insert: vi.fn(),
    findById: vi.fn(),
    listByProject: vi.fn((projectId: string, pagination: { limit: number; offset: number }) => {
      const all =
        projectId === PROJECT_A
          ? [environmentA1, environmentA2]
          : projectId === PROJECT_B
            ? [environmentB1]
            : [];
      const items = all.slice(pagination.offset, pagination.offset + pagination.limit);
      return Promise.resolve({ items, total: all.length });
    }),
    setEnabled: vi.fn(),
    ...options.environments,
  };

  return {
    projects,
    environments,
    credentialScopes: scopeRepo(options.scopes ?? []),
  };
}

describe('listEnvironments', () => {
  it('returns paginated environments for operator', async () => {
    const deps = buildDeps({});
    const result = await listEnvironments(deps, {
      role: 'operator',
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_A,
      limit: 50,
      offset: 0,
    });

    expect(result.items).toEqual([environmentA1, environmentA2]);
    expect(result.total).toBe(2);
    expect(deps.environments.listByProject).toHaveBeenCalledWith(PROJECT_A, { limit: 50, offset: 0 });
  });

  it('returns paginated environments for read-only', async () => {
    const deps = buildDeps({});
    const result = await listEnvironments(deps, {
      role: 'read-only',
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_A,
      limit: 1,
      offset: 1,
    });

    expect(result.items).toEqual([environmentA2]);
    expect(result.total).toBe(2);
  });

  it('allows in-scope project-service credentials', async () => {
    const deps = buildDeps({
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: now,
        },
      ],
    });

    const result = await listEnvironments(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_A,
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
  });

  it('allows project-service with env-level-only scope for project-level read (C6)', async () => {
    const deps = buildDeps({
      scopes: [
        {
          id: 'scope-env',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: ENV_A1,
          createdAt: now,
        },
      ],
    });

    const result = await listEnvironments(deps, {
      role: 'project-service',
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_A,
      limit: 50,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
  });

  it('denies out-of-scope project-service with SCOPE_DENIED after project exists', async () => {
    const deps = buildDeps({
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: now,
        },
      ],
    });

    await expect(
      listEnvironments(deps, {
        role: 'project-service',
        credentialId: CREDENTIAL_ID,
        projectId: PROJECT_B,
        limit: 50,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    expect(deps.environments.listByProject).not.toHaveBeenCalled();
  });

  it('returns 404 PROJECT_NOT_FOUND for unknown project before scope check', async () => {
    const deps = buildDeps({
      projects: {
        findById: vi.fn(() => Promise.resolve(undefined)),
      },
    });

    await expect(
      listEnvironments(deps, {
        role: 'operator',
        credentialId: CREDENTIAL_ID,
        projectId: '99999999-9999-4999-8999-999999999999',
        limit: 50,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    expect(deps.environments.listByProject).not.toHaveBeenCalled();
  });

  it('denies cron roles with INSUFFICIENT_ROLE', async () => {
    const deps = buildDeps({});
    for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
      await expect(
        listEnvironments(deps, {
          role,
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          limit: 50,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    }
    expect(deps.environments.listByProject).not.toHaveBeenCalled();
  });

  describe('pagination parsing via shared helpers', () => {
    it('defaults limit and offset when absent', () => {
      expect(parsePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
      expect(parsePageOffset(undefined)).toBe(0);
    });

    it('parses string query values', () => {
      expect(parsePageLimit('50')).toBe(50);
      expect(parsePageOffset('0')).toBe(0);
    });
  });
});
