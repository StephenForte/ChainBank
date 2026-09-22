import { assertPermission, type Role } from '../../domain/auth/roles.js';
import type { EmailDeliveryListFilters, EmailDeliveryListPage, EmailDeliveryRepository } from '../ports.js';

export interface ListEmailDeliveriesDependencies {
  readonly emailDeliveries: EmailDeliveryRepository;
}

export interface ListEmailDeliveriesInput extends EmailDeliveryListFilters {
  readonly role: Role;
}

/**
 * Newest-first delivery log (C35).
 *
 * `alert:read` is the same permission as the alerts list: operator, read-only,
 * and therefore dashboard admin, operator, and viewer. The body is not in the
 * row, so this read cannot restate balances the subject already omitted.
 */
export async function listEmailDeliveries(
  dependencies: ListEmailDeliveriesDependencies,
  input: ListEmailDeliveriesInput,
): Promise<EmailDeliveryListPage> {
  assertPermission(input.role, 'alert:read');
  return dependencies.emailDeliveries.list({
    limit: input.limit,
    offset: input.offset,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
  });
}
