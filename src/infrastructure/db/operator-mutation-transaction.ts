import type { OperatorMutationTransaction, OperatorMutationUnitOfWork } from '../../app/ports.js';
import { withDatabaseErrors, type Database } from './client.js';
import { createAlertRepository } from './repositories/alert-repository.js';
import { createApiCredentialRepository } from './repositories/api-credential-repository.js';
import { createAuditEventRepository } from './repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from './repositories/balance-observation-repository.js';
import { createChainRepository } from './repositories/chain-repository.js';
import { createEnvironmentRepository } from './repositories/environment-repository.js';
import { createFundingPolicyRepository } from './repositories/funding-policy-repository.js';
import { createManagedWalletRepository } from './repositories/managed-wallet-repository.js';
import { createProjectRepository } from './repositories/project-repository.js';
import { createTreasuryRepository } from './repositories/treasury-repository.js';

/**
 * Postgres unit of work for operator-facing mutations that must commit with
 * their audit entry (C21 / AGENTS.md §7.7).
 *
 * Mirrors {@link createFundingDispatchLock}: open a transaction, rebind
 * repository factories to the transaction client, and hand the caller a
 * typed unit of work. Do not construct this from an existing transaction
 * client — nesting is unsupported and would create savepoints rather than a
 * top-level atomic boundary.
 */
export function createOperatorMutationTransaction(db: Database): OperatorMutationTransaction {
  return {
    async run<T>(work: (uow: OperatorMutationUnitOfWork) => Promise<T>): Promise<T> {
      return withDatabaseErrors('operator.mutationTransaction', () =>
        db.transaction(async (tx) => {
          // Drizzle's transaction client exposes the same query API as Database.
          const txDb: Database = tx;
          const uow: OperatorMutationUnitOfWork = {
            alerts: createAlertRepository(txDb),
            auditEvents: createAuditEventRepository(txDb),
            apiCredentials: createApiCredentialRepository(txDb),
            treasuries: createTreasuryRepository(txDb),
            balanceObservations: createBalanceObservationRepository(txDb),
            managedWallets: createManagedWalletRepository(txDb),
            fundingPolicies: createFundingPolicyRepository(txDb),
            projects: createProjectRepository(txDb),
            environments: createEnvironmentRepository(txDb),
            chains: createChainRepository(txDb),
          };
          return work(uow);
        }),
      );
    },
  };
}
