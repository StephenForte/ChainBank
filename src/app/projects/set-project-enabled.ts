import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { OperatorMutationTransaction, Project } from '../ports.js';

export interface SetProjectEnabledDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
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
 * The enablement write and its audit entry commit atomically (C21).
 */
export async function setProjectEnabled(
  dependencies: SetProjectEnabledDependencies,
  input: SetProjectEnabledInput,
): Promise<Project> {
  assertPermission(input.role, 'project:write');

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.projects.findById(input.projectId);
    if (existing === undefined) {
      throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${input.projectId} does not exist`);
    }

    const project = await uow.projects.setEnabled(input.projectId, input.enabled);

    await uow.auditEvents.record({
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
  });
}
