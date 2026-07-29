import { authorizeScope, resolveReadableProjectIds } from '../auth/authorize-scope.js';
import type { Role } from '../../domain/auth/roles.js';
import type {
  CredentialScope,
  CredentialScopeRepository,
  EnvironmentRepository,
  FundingTransactionHistoryItem,
  FundingTransactionListFilter,
  FundingTransactionRepository,
  FundingTransactionScopeClause,
  FundingTransactionScopeFilter,
  ManagedWalletRepository,
} from '../ports.js';
import { assertFundingReadPermission } from './assert-funding-read.js';

export interface ListFundingTransactionsDependencies {
  readonly fundingTransactions: FundingTransactionRepository;
  readonly credentialScopes: CredentialScopeRepository;
  readonly environments: EnvironmentRepository;
  readonly managedWallets: ManagedWalletRepository;
}

export interface ListFundingTransactionsInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly filter: FundingTransactionListFilter;
  readonly limit: number;
  readonly offset: number;
}

export interface ListFundingTransactionsResult {
  readonly items: readonly FundingTransactionHistoryItem[];
  readonly total: number;
}

/** Lists funding transactions with scope-aware authorization and optional filters. */
export async function listFundingTransactions(
  dependencies: ListFundingTransactionsDependencies,
  input: ListFundingTransactionsInput,
): Promise<ListFundingTransactionsResult> {
  assertFundingReadPermission(input.role);

  const allowedProjectIds = await resolveReadableProjectIds(
    { credentialScopes: dependencies.credentialScopes },
    { role: input.role, credentialId: input.credentialId },
  );

  if (allowedProjectIds !== undefined && allowedProjectIds.length === 0) {
    return { items: [], total: 0 };
  }

  await assertFilterAuthorization(dependencies, input);

  const scope = await buildScopeFilter(dependencies, input.credentialId, allowedProjectIds);

  return dependencies.fundingTransactions.list(
    { ...input.filter, scope },
    { limit: input.limit, offset: input.offset },
  );
}

async function assertFilterAuthorization(
  dependencies: ListFundingTransactionsDependencies,
  input: ListFundingTransactionsInput,
): Promise<void> {
  const scopeDeps = { credentialScopes: dependencies.credentialScopes };

  if (input.filter.projectId !== undefined) {
    await authorizeScope(
      scopeDeps,
      input.filter.environmentId === undefined
        ? {
            role: input.role,
            credentialId: input.credentialId,
            action: 'read',
            projectId: input.filter.projectId,
          }
        : {
            role: input.role,
            credentialId: input.credentialId,
            action: 'read',
            projectId: input.filter.projectId,
            environmentId: input.filter.environmentId,
          },
    );
    return;
  }

  if (input.filter.environmentId !== undefined) {
    const environment = await dependencies.environments.findById(input.filter.environmentId);
    if (environment === undefined) {
      return;
    }
    await authorizeScope(scopeDeps, {
      role: input.role,
      credentialId: input.credentialId,
      action: 'read',
      projectId: environment.projectId,
      environmentId: environment.id,
    });
    return;
  }

  if (input.filter.managedWalletId !== undefined) {
    const wallet = await dependencies.managedWallets.findById(input.filter.managedWalletId);
    if (wallet === undefined) {
      return;
    }
    await authorizeScope(scopeDeps, {
      role: input.role,
      credentialId: input.credentialId,
      action: 'read',
      projectId: wallet.project.id,
      environmentId: wallet.environment.id,
    });
  }
}

async function buildScopeFilter(
  dependencies: ListFundingTransactionsDependencies,
  credentialId: string,
  allowedProjectIds: readonly string[] | undefined,
): Promise<FundingTransactionScopeFilter> {
  if (allowedProjectIds === undefined) {
    return { kind: 'unrestricted' };
  }

  const scopes = await dependencies.credentialScopes.listByCredentialId(credentialId);
  return {
    kind: 'scoped',
    clauses: buildScopeClauses(scopes),
  };
}

function buildScopeClauses(scopes: readonly CredentialScope[]): readonly FundingTransactionScopeClause[] {
  return scopes.map((scope) =>
    scope.environmentId === undefined
      ? { projectId: scope.projectId }
      : { projectId: scope.projectId, environmentId: scope.environmentId },
  );
}
