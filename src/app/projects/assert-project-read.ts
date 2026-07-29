import { assertPermission, type Role } from '../../domain/auth/roles.js';

/**
 * Project-service credentials read via api_credential_scopes, not the global
 * project:read permission. Forgetting authorizeScope would otherwise grant
 * unrestricted access if project:read were added to that role.
 */
export function assertProjectReadPermission(role: Role): void {
  if (role === 'project-service') {
    return;
  }
  assertPermission(role, 'project:read');
}
