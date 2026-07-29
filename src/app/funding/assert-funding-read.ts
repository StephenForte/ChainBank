import { assertPermission, type Role } from '../../domain/auth/roles.js';

/**
 * Project-service credentials read funding history via api_credential_scopes,
 * not a global permission. Other roles require wallet:read; cron roles are denied.
 */
export function assertFundingReadPermission(role: Role): void {
  if (role === 'project-service') {
    return;
  }
  assertPermission(role, 'wallet:read');
}
