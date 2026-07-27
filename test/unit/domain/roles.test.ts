import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  assertPermission,
  roleHasPermission,
  type Permission,
  type Role,
} from '../../../src/domain/auth/roles.js';

describe('role permissions (Phase 0)', () => {
  it('grants the operator full Phase 0 capabilities', () => {
    expect(roleHasPermission('operator', 'treasury:read')).toBe(true);
    expect(roleHasPermission('operator', 'treasury:check')).toBe(true);
    expect(roleHasPermission('operator', 'email:test')).toBe(true);
  });

  it('keeps read-only credentials from mutating actions', () => {
    expect(roleHasPermission('read-only', 'treasury:read')).toBe(true);
    expect(roleHasPermission('read-only', 'treasury:check')).toBe(false);
    expect(roleHasPermission('read-only', 'email:test')).toBe(false);
  });

  it('allows the treasury monitor to check balances but not send test email', () => {
    expect(roleHasPermission('cron-treasury-monitor', 'treasury:check')).toBe(true);
    expect(roleHasPermission('cron-treasury-monitor', 'email:test')).toBe(false);
  });

  it('denies by default for roles with no Phase 0 permissions', () => {
    const deferred: readonly Role[] = ['project-service', 'cron-reconciler'];
    const permissions: readonly Permission[] = ['treasury:read', 'treasury:check', 'email:test'];
    for (const role of deferred) {
      for (const permission of permissions) {
        expect(roleHasPermission(role, permission)).toBe(false);
      }
    }
  });

  it('throws a stable authorization error when a permission is missing', () => {
    expect(() => assertPermission('read-only', 'email:test')).toThrow(ChainBankError);
    try {
      assertPermission('read-only', 'email:test');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INSUFFICIENT_ROLE');
      expect((error as ChainBankError).httpStatus).toBe(403);
    }
  });
});
