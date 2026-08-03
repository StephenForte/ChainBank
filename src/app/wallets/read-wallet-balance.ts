import { authorizeScope } from '../auth/authorize-scope.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { BalanceReading } from '../../domain/balance-reading.js';
import { ChainBankError } from '../../domain/errors.js';
import type {
  BalanceReader,
  CredentialScopeRepository,
  ManagedWallet,
  ManagedWalletRepository,
} from '../ports.js';

export interface ReadWalletBalanceDependencies {
  readonly managedWallets: ManagedWalletRepository;
  readonly credentialScopes: CredentialScopeRepository;
  readonly balanceReader: BalanceReader;
}

export interface ReadWalletBalanceInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly walletId: string;
}

export interface ReadWalletBalanceResult {
  readonly wallet: ManagedWallet;
  readonly reading: BalanceReading;
}

/**
 * Project-service credentials read via api_credential_scopes, not the global
 * wallet:read permission. Forgetting authorizeScope would otherwise grant
 * unrestricted access if wallet:read were added to that role.
 */
function assertWalletReadPermission(role: Role): void {
  if (role === 'project-service') {
    return;
  }
  assertPermission(role, 'wallet:read');
}

/**
 * Fresh on-chain balance for one managed wallet (C17).
 *
 * Read-only: never writes balance_observations. Authz mirrors C13 get-by-id
 * order (permission → existence → scope) so a scoped credential cannot learn
 * another project's address balance. Provider failure returns an `unavailable`
 * reading — never a fabricated zero (AGENTS.md §7).
 */
export async function readWalletBalance(
  dependencies: ReadWalletBalanceDependencies,
  input: ReadWalletBalanceInput,
): Promise<ReadWalletBalanceResult> {
  assertWalletReadPermission(input.role);

  const wallet = await dependencies.managedWallets.findById(input.walletId);
  if (wallet === undefined) {
    throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${input.walletId} does not exist`, {
      publicMessage: 'The managed wallet was not found.',
    });
  }

  await authorizeScope(
    { credentialScopes: dependencies.credentialScopes },
    {
      role: input.role,
      credentialId: input.credentialId,
      action: 'read',
      projectId: wallet.project.id,
      environmentId: wallet.environment.id,
    },
  );

  const reading = await dependencies.balanceReader.readBalance(wallet.addressDisplay);
  return { wallet, reading };
}
