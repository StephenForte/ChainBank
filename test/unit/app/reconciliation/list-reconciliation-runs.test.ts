import { describe, expect, it, vi } from 'vitest';
import { listReconciliationRuns } from '../../../../src/app/reconciliation/list-reconciliation-runs.js';
import type { ReconciliationRun, ReconciliationRunRepository } from '../../../../src/app/ports.js';
import type { ChainBankError } from '../../../../src/domain/errors.js';
import type { Role } from '../../../../src/domain/auth/roles.js';

function fakeRepo(page: {
  readonly items: readonly ReconciliationRun[];
  readonly total: number;
}): ReconciliationRunRepository {
  return {
    insertStarted: vi.fn(),
    markFinished: vi.fn(),
    findById: vi.fn(),
    listRecent: vi.fn(),
    list: vi.fn().mockResolvedValue(page),
    count: vi.fn().mockResolvedValue(page.total),
  };
}

describe('listReconciliationRuns (C19)', () => {
  it('allows operator and read-only', async () => {
    const repo = fakeRepo({ items: [], total: 0 });
    for (const role of ['operator', 'read-only'] as const) {
      await expect(
        listReconciliationRuns({ reconciliationRuns: repo }, { role, limit: 50, offset: 0 }),
      ).resolves.toEqual({ items: [], total: 0 });
    }
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('denies project-service and cron roles with INSUFFICIENT_ROLE', async () => {
    const repo = fakeRepo({ items: [], total: 0 });
    const denied: readonly Role[] = ['project-service', 'cron-reconciler', 'cron-treasury-monitor'];
    for (const role of denied) {
      await expect(
        listReconciliationRuns({ reconciliationRuns: repo }, { role, limit: 50, offset: 0 }),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_ROLE',
      } satisfies Partial<ChainBankError>);
    }
    expect(repo.list).not.toHaveBeenCalled();
  });
});
