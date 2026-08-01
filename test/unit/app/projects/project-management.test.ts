import { describe, expect, it, vi } from 'vitest';
import { setProjectEnabled } from '../../../../src/app/projects/set-project-enabled.js';
import { setEnvironmentEnabled } from '../../../../src/app/projects/set-environment-enabled.js';
import type {
  AuditEventRepository,
  Environment,
  EnvironmentRepository,
  Project,
  ProjectRepository,
} from '../../../../src/app/ports.js';

const now = new Date('2026-07-28T12:00:00.000Z');

const project: Project = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  slug: 'fortel2',
  name: 'ForteL2',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const environment: Environment = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  projectId: project.id,
  slug: 'dev',
  name: 'Development',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

describe('disable without delete', () => {
  it('updates project enabled flag in place', async () => {
    const projects: ProjectRepository = {
      insert: vi.fn(),
      findById: vi.fn(() => Promise.resolve(project)),
      findBySlug: vi.fn(),
      list: vi.fn(),
      listByIds: vi.fn(),
      setEnabled: vi.fn((_id: string, enabled: boolean) =>
        Promise.resolve({ ...project, enabled, updatedAt: new Date('2026-07-28T13:00:00.000Z') }),
      ),
    };
    const auditEvents: AuditEventRepository = {
      record: vi.fn(() => Promise.resolve(undefined)),
    };

    const updated = await setProjectEnabled(
      { projects, auditEvents },
      {
        role: 'operator',
        projectId: project.id,
        enabled: false,
        operationId: 'req-1',
        actorId: 'cred-1',
        sourceIp: '127.0.0.1',
      },
    );

    expect(updated.enabled).toBe(false);
    expect(projects.setEnabled).toHaveBeenCalledWith(project.id, false);
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.disabled', entityId: project.id }),
    );
  });

  it('updates environment enabled flag in place', async () => {
    const environments: EnvironmentRepository = {
      insert: vi.fn(),
      findById: vi.fn(() => Promise.resolve(environment)),
      listByProject: vi.fn(),
      setEnabled: vi.fn((_id: string, enabled: boolean) =>
        Promise.resolve({
          ...environment,
          enabled,
          updatedAt: new Date('2026-07-28T13:00:00.000Z'),
        }),
      ),
    };
    const auditEvents: AuditEventRepository = {
      record: vi.fn(() => Promise.resolve(undefined)),
    };

    const updated = await setEnvironmentEnabled(
      { environments, auditEvents },
      {
        role: 'operator',
        environmentId: environment.id,
        enabled: false,
        operationId: 'req-2',
        actorId: 'cred-1',
        sourceIp: undefined,
      },
    );

    expect(updated.enabled).toBe(false);
    expect(environments.setEnabled).toHaveBeenCalledWith(environment.id, false);
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'environment.disabled', entityId: environment.id }),
    );
  });

  it('rejects read-only credentials from disabling projects', async () => {
    const projects: ProjectRepository = {
      insert: vi.fn(),
      findById: vi.fn(),
      findBySlug: vi.fn(),
      list: vi.fn(),
      listByIds: vi.fn(),
      setEnabled: vi.fn(),
    };

    await expect(
      setProjectEnabled(
        { projects, auditEvents: { record: vi.fn() } },
        {
          role: 'read-only',
          projectId: project.id,
          enabled: false,
          operationId: 'req-3',
          actorId: 'cred-2',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('audit emission on project create', () => {
  it('records project.created after insert', async () => {
    const { createProject } = await import('../../../../src/app/projects/create-project.js');
    const projects: ProjectRepository = {
      insert: vi.fn(() => Promise.resolve(project)),
      findById: vi.fn(),
      findBySlug: vi.fn(),
      list: vi.fn(),
      listByIds: vi.fn(),
      setEnabled: vi.fn(),
    };
    const auditEvents: AuditEventRepository = {
      record: vi.fn(() => Promise.resolve(undefined)),
    };

    await createProject(
      { projects, auditEvents },
      {
        role: 'operator',
        slug: 'fortel2',
        name: 'ForteL2',
        operationId: 'req-4',
        actorId: 'cred-1',
        sourceIp: '10.0.0.1',
      },
    );

    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.created',
        entityType: 'project',
        entityId: project.id,
        requestId: 'req-4',
      }),
    );
  });
});
