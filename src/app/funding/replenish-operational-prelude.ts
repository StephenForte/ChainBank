import type { Role } from '../../domain/auth/roles.js';
import { resolveOperationalTreasury } from '../../domain/treasury/resolve-treasury.js';
import type { Logger } from '../../observability/logger.js';
import type { TreasuryRepository } from '../ports.js';
import {
  ensureOperationalTreasuryFunded,
  type EnsureOperationalTreasuryFundedDependencies,
} from './ensure-operational-treasury-funded.js';

/**
 * When a Private treasury is configured, refill it from Public before wallet
 * funding (D14). Legacy single-treasury mode is a no-op.
 *
 * Failures propagate — a dry Private pile must not look like wallet readiness.
 */
export async function replenishOperationalPrelude(
  dependencies: EnsureOperationalTreasuryFundedDependencies & {
    readonly treasuries: TreasuryRepository;
    readonly logger: Logger;
  },
  input: {
    readonly evmChainId: number;
    readonly role: Role;
    readonly credentialId: string;
    readonly correlationId: string;
    readonly sourceIp: string | undefined;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  const enabled = await dependencies.treasuries.listEnabled();
  const resolution = resolveOperationalTreasury(enabled, input.evmChainId);
  if (resolution.kind === 'error') {
    return;
  }

  const result = await ensureOperationalTreasuryFunded(dependencies, {
    operationalTreasuryId: resolution.treasury.id,
    idempotencyKey: input.idempotencyKey,
    role: input.role,
    credentialId: input.credentialId,
    correlationId: input.correlationId,
    sourceIp: input.sourceIp,
  });

  dependencies.logger.info(
    {
      correlationId: input.correlationId,
      operationalTreasuryId: resolution.treasury.id,
      status: result.status,
      operationId: result.operationId,
      reasonCode: result.reasonCode,
    },
    'Operational treasury replenish prelude completed',
  );
}
