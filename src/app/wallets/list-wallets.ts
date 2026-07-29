import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { ManagedWalletListFilter, ManagedWalletListPage, ManagedWalletRepository } from '../ports.js';

export interface ListWalletsDependencies {
  readonly managedWallets: ManagedWalletRepository;
}

export interface ListWalletsInput {
  readonly role: Role;
  readonly filter: ManagedWalletListFilter;
  readonly limit: number;
  readonly offset: number;
}

/** Lists managed wallets with optional project/environment/enabled filters. */
export async function listWallets(
  dependencies: ListWalletsDependencies,
  input: ListWalletsInput,
): Promise<ManagedWalletListPage> {
  assertPermission(input.role, 'wallet:read');
  return dependencies.managedWallets.list(input.filter, {
    limit: input.limit,
    offset: input.offset,
  });
}
