import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { parseSlug } from '../../domain/projects/slug.js';
import type {
  AuditEventRepository,
  Environment,
  EnvironmentRepository,
  ProjectRepository,
} from '../ports.js';

export interface CreateEnvironmentDependencies {
  readonly projects: ProjectRepository;
  readonly environments: EnvironmentRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface CreateEnvironmentInput {
  readonly role: Role;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

export async function createEnvironment(
  dependencies: CreateEnvironmentDependencies,
  input: CreateEnvironmentInput,
): Promise<Environment> {
  assertPermission(input.role, 'project:write');

  const project = await dependencies.projects.findById(input.projectId);
  if (project === undefined) {
    throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${input.projectId} does not exist`);
  }

  const slug = parseSlug(input.slug, 'slug');
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ChainBankError('INVALID_REQUEST', 'Environment name must not be empty', {
      publicMessage: 'An environment name is required.',
    });
  }

  const environment = await dependencies.environments.insert({
    projectId: project.id,
    slug,
    name,
  });

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: 'environment.created',
    entityType: 'environment',
    entityId: environment.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: { projectId: project.id, slug: environment.slug, name: environment.name },
  });

  return environment;
}
