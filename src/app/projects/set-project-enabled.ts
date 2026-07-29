import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { AuditEventRepository, Project, ProjectRepository } from '../ports.js';

export interface SetProjectEnabledDependencies {
  readonly projects: ProjectRepository;
  readonly auditEvents: AuditEventRepository;
}

export interface SetProjectEnabledInput {
  readonly role: Role;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Enables or disables a project without deleting historical rows.
 */
export async function setProjectEnabled(
  dependencies: SetProjectEnabledDependencies,
  input: SetProjectEnabledInput,
): Promise<Project> {
  assertPermission(input.role, 'project:write');

  const existing = await dependencies.projects.findById(input.projectId);
  if (existing === undefined) {
    throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${input.projectId} does not exist`);
  }

  const project = await dependencies.projects.setEnabled(input.projectId, input.enabled);

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: input.enabled ? 'project.enabled' : 'project.disabled',
    entityType: 'project',
    entityId: project.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: { slug: project.slug, enabled: project.enabled },
  });

  return project;
}
