import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { AlertLifecycleState, AlertListPage, AlertRepository } from '../ports.js';

export interface ListAlertsDependencies {
  readonly alerts: AlertRepository;
}

export interface ListAlertsInput {
  readonly role: Role;
  readonly limit: number;
  readonly offset: number;
  readonly alertType?: string;
  readonly state?: AlertLifecycleState;
  readonly entityType?: string;
}

/**
 * Lists alerts newest-first by first_triggered_at (C20).
 *
 * Authorization is role-only: alerts are treasury-global and carry forensic
 * detail spanning every project, so scope-based grants cannot express the
 * boundary. `project-service` is denied even with scope rows.
 */
export async function listAlerts(
  dependencies: ListAlertsDependencies,
  input: ListAlertsInput,
): Promise<AlertListPage> {
  assertPermission(input.role, 'alert:read');
  return dependencies.alerts.list({
    limit: input.limit,
    offset: input.offset,
    ...(input.alertType !== undefined ? { alertType: input.alertType } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
  });
}
