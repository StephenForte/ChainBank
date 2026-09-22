import { describe, expect, it } from 'vitest';
import {
  permissionsForActor,
  permissionsForDashboardRole,
  roleHasPermission,
} from '../../../src/domain/auth/roles.js';
import { apiRoleForDashboardRole } from '../../../src/domain/auth/users.js';

describe('dashboard role mapping', () => {
  it('gives admin the operator set plus user:manage, and withholds that permission from API roles', () => {
    const admin = permissionsForDashboardRole('admin');
    expect(admin).toContain('treasury:write');
    expect(admin).toContain('user:manage');
    expect(permissionsForDashboardRole('operator')).not.toContain('user:manage');
    expect(permissionsForDashboardRole('viewer')).toEqual([
      'treasury:read',
      'wallet:read',
      'project:read',
      'reconciliation:read',
      'alert:read',
    ]);

    expect(roleHasPermission('operator', 'user:manage')).toBe(false);
    expect(roleHasPermission('read-only', 'user:manage')).toBe(false);
    expect(apiRoleForDashboardRole('admin')).toBe('operator');
    expect(apiRoleForDashboardRole('operator')).toBe('operator');
    expect(apiRoleForDashboardRole('viewer')).toBe('read-only');
  });

  it('authorises a dashboard admin on user:manage and an API operator on the mapped role only', () => {
    expect(
      permissionsForActor({ kind: 'dashboard_user', role: 'operator', dashboardRole: 'admin' }),
    ).toContain('user:manage');
    expect(permissionsForActor({ kind: 'api_credential', role: 'operator' })).not.toContain('user:manage');
    expect(permissionsForActor({ role: 'operator' })).toContain('treasury:read');
  });
});
