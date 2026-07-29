import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { AuditEventRepository, Environment, EnvironmentRepository } from '../ports.js';

export interface SetEnvironmentEnabledDependencies {
  readonly environments: EnvironmentRepository;
  readonly auditEvents: AuditEventRepository;
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
 */
export async function setEnvironmentEnabled(
  dependencies: SetEnvironmentEnabledDependencies,
  input: SetEnvironmentEnabledInput,
): Promise<Environment> {
  assertPermission(input.role, 'project:write');

  const existing = await dependencies.environments.findById(input.environmentId);
  if (existing === undefined) {
    throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} does not exist`);
  }

  const environment = await dependencies.environments.setEnabled(input.environmentId, input.enabled);

  await dependencies.auditEvents.record({
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
}
