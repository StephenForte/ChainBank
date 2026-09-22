import type { Role } from './roles.js';
import { ChainBankError } from '../errors.js';

/** Dashboard accounts (C31 / D24). Distinct from API credential {@link Role}. */
export const DASHBOARD_ROLES = ['admin', 'operator', 'viewer'] as const;

export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 200;

export function isDashboardRole(value: unknown): value is DashboardRole {
  return typeof value === 'string' && (DASHBOARD_ROLES as readonly string[]).includes(value);
}

/**
 * API role a dashboard session is authorised as.
 *
 * `admin` and `operator` both map to the operator permission set; `admin`
 * additionally holds `user:manage`, which is not an API-role grant. `viewer`
 * maps to read-only. Existing routes keep calling `assertPermission(actor.role)`.
 */
export function apiRoleForDashboardRole(role: DashboardRole): Role {
  switch (role) {
    case 'admin':
    case 'operator':
      return 'operator';
    case 'viewer':
      return 'read-only';
    default:
      return assertNeverDashboardRole(role);
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalized)) {
    throw new ChainBankError('INVALID_REQUEST', 'Dashboard user email is not a usable address', {
      publicMessage: 'Enter a valid email address.',
    });
  }
  return normalized;
}

export function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length === 0 || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ChainBankError('INVALID_REQUEST', 'Dashboard display name is empty or too long', {
      publicMessage: 'Enter a display name.',
    });
  }
  return normalized;
}

function assertNeverDashboardRole(role: never): never {
  throw new Error(`Unhandled dashboard role: ${String(role)}`);
}
