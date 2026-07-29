import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { parseSlug } from '../../domain/projects/slug.js';
import type { AuditEventRepository, Project, ProjectRepository } from '../ports.js';

export interface CreateProjectDependencies {
  readonly projects: ProjectRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface CreateProjectInput {
  readonly role: Role;
  readonly slug: string;
  readonly name: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

export async function createProject(
  dependencies: CreateProjectDependencies,
  input: CreateProjectInput,
): Promise<Project> {
  assertPermission(input.role, 'project:write');

  const slug = parseSlug(input.slug, 'slug');
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ChainBankError('INVALID_REQUEST', 'Project name must not be empty', {
      publicMessage: 'A project name is required.',
    });
  }

  const project = await dependencies.projects.insert({ slug, name });

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: 'project.created',
    entityType: 'project',
    entityId: project.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: { slug: project.slug, name: project.name },
  });

  return project;
}
