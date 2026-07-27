import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { Treasury, TreasuryRepository } from '../ports.js';

export interface ListTreasuriesDependencies {
  readonly treasuries: TreasuryRepository;
}

/**
 * Returns the last recorded state of each enabled treasury.
 *
 * This reads only what previous checks persisted; it never calls the chain, so
 * the dashboard stays fast and a provider outage degrades freshness rather than
 * availability.
 */
export async function listTreasuries(
  dependencies: ListTreasuriesDependencies,
  input: { readonly role: Role },
): Promise<readonly Treasury[]> {
  assertPermission(input.role, 'treasury:read');
  return dependencies.treasuries.listEnabled();
}
