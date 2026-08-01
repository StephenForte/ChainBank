import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../src/domain/errors.js';
import {
  assertPermission,
  roleHasPermission,
  type Permission,
  type Role,
} from '../../../src/domain/auth/roles.js';

describe('role permissions', () => {
  it('grants the operator treasury and wallet capabilities', () => {
    expect(roleHasPermission('operator', 'treasury:read')).toBe(true);
    expect(roleHasPermission('operator', 'treasury:check')).toBe(true);
    expect(roleHasPermission('operator', 'treasury:write')).toBe(true);
    expect(roleHasPermission('operator', 'email:test')).toBe(true);
    expect(roleHasPermission('operator', 'wallet:read')).toBe(true);
    expect(roleHasPermission('operator', 'wallet:write')).toBe(true);
    expect(roleHasPermission('operator', 'project:read')).toBe(true);
    expect(roleHasPermission('operator', 'project:write')).toBe(true);
    expect(roleHasPermission('operator', 'credential:read')).toBe(true);
    expect(roleHasPermission('operator', 'credential:write')).toBe(true);
  });

  it('keeps read-only credentials from mutating actions', () => {
    expect(roleHasPermission('read-only', 'treasury:read')).toBe(true);
    expect(roleHasPermission('read-only', 'wallet:read')).toBe(true);
    expect(roleHasPermission('read-only', 'project:read')).toBe(true);
    expect(roleHasPermission('read-only', 'treasury:check')).toBe(false);
    expect(roleHasPermission('read-only', 'treasury:write')).toBe(false);
    expect(roleHasPermission('read-only', 'email:test')).toBe(false);
    expect(roleHasPermission('read-only', 'wallet:write')).toBe(false);
    expect(roleHasPermission('read-only', 'project:write')).toBe(false);
  });

  it('allows the treasury monitor to check balances but not send test email', () => {
    expect(roleHasPermission('cron-treasury-monitor', 'treasury:check')).toBe(true);
    expect(roleHasPermission('cron-treasury-monitor', 'treasury:write')).toBe(false);
    expect(roleHasPermission('cron-treasury-monitor', 'email:test')).toBe(false);
    expect(roleHasPermission('cron-treasury-monitor', 'wallet:write')).toBe(false);
  });

  it('denies by default for roles with no granted permissions', () => {
    const deferred: readonly Role[] = ['project-service', 'cron-reconciler'];
    const permissions: readonly Permission[] = [
      'treasury:read',
      'treasury:check',
      'treasury:write',
      'email:test',
      'wallet:read',
      'wallet:write',
      'project:read',
      'project:write',
      'credential:read',
      'credential:write',
    ];
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
