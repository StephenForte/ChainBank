import { ChainBankError } from '../errors.js';

/**
 * The full role vocabulary from the PRD. Roles whose capabilities arrive in a
 * later phase are declared now so the persisted enum stays stable, but they
 * hold no permissions until that phase implements them.
 */
export const ROLES = [
  'operator',
  'project-service',
  'read-only',
  'cron-treasury-monitor',
  'cron-reconciler',
] as const;

export type Role = (typeof ROLES)[number];

/** Capabilities that exist in Phase 0. Funding permissions arrive with Phase 1. */
export const PERMISSIONS = ['treasury:read', 'treasury:check', 'email:test'] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSIONS_BY_ROLE: Readonly<Record<Role, readonly Permission[]>> = {
  operator: ['treasury:read', 'treasury:check', 'email:test'],
  'read-only': ['treasury:read'],
  // The monitor reads the treasury and records observations. It never signs and
  // never triggers operator-facing administrative actions.
  'cron-treasury-monitor': ['treasury:read', 'treasury:check'],
  // No Phase 0 capabilities. Deny by default until their phases land.
  'project-service': [],
  'cron-reconciler': [],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].includes(permission);
}

/**
 * Authorization is enforced here, inside application services, rather than
 * relying on route registration alone.
 */
export function assertPermission(role: Role, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new ChainBankError('INSUFFICIENT_ROLE', `Role "${role}" lacks permission "${permission}"`, {
      context: { role, permission },
    });
  }
}
