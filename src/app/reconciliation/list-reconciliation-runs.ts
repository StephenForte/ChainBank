import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { ReconciliationRun, ReconciliationRunRepository } from '../ports.js';

export interface ListReconciliationRunsDependencies {
  readonly reconciliationRuns: ReconciliationRunRepository;
}

export interface ListReconciliationRunsInput {
  readonly role: Role;
  readonly limit: number;
  readonly offset: number;
}

export interface ListReconciliationRunsResult {
  readonly items: readonly ReconciliationRun[];
  readonly total: number;
}

/**
 * Lists reconciliation runs newest-first (C19).
 *
 * Authorization is role-only: runs are treasury-global and findings carry
 * forensic detail spanning every project, so scope-based grants cannot express
 * the boundary. `project-service` is denied even with scope rows.
 */
export async function listReconciliationRuns(
  dependencies: ListReconciliationRunsDependencies,
  input: ListReconciliationRunsInput,
): Promise<ListReconciliationRunsResult> {
  assertPermission(input.role, 'reconciliation:read');
  return dependencies.reconciliationRuns.list({
    limit: input.limit,
    offset: input.offset,
  });
}
