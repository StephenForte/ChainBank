import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Environment, OperatorMutationTransaction } from '../ports.js';

export interface SetEnvironmentEnabledDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
}

export interface SetEnvironmentEnabledInput {
  readonly role: Role;
  readonly environmentId: string;
  readonly enabled: boolean;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Enables or disables an environment without deleting historical rows.
 * The enablement write and its audit entry commit atomically (C21).
 */
export async function setEnvironmentEnabled(
  dependencies: SetEnvironmentEnabledDependencies,
  input: SetEnvironmentEnabledInput,
): Promise<Environment> {
  assertPermission(input.role, 'project:write');

  return dependencies.operatorMutations.run(async (uow) => {
    const existing = await uow.environments.findById(input.environmentId);
    if (existing === undefined) {
      throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} does not exist`);
    }

    const environment = await uow.environments.setEnabled(input.environmentId, input.enabled);

    await uow.auditEvents.record({
      actorType: 'api_credential',
      actorId: input.actorId,
      action: input.enabled ? 'environment.enabled' : 'environment.disabled',
      entityType: 'environment',
      entityId: environment.id,
      requestId: input.operationId,
      sourceIp: input.sourceIp,
      metadata: {
        projectId: environment.projectId,
        slug: environment.slug,
        enabled: environment.enabled,
      },
    });

    return environment;
  });
}
