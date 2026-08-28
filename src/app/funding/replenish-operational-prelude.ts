import type { Role } from '../../domain/auth/roles.js';
import { isChainBankError } from '../../domain/errors.js';
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
 * A dry Private pile that cannot be served must still fail later wallet
 * funding. An already-in-flight replenish must not abort wallet work — Private
 * may already have spendable balance.
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

  try {
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
  } catch (error) {
    if (isChainBankError(error) && error.code === 'PENDING_FUNDING_EXISTS') {
      dependencies.logger.info(
        {
          correlationId: input.correlationId,
          operationalTreasuryId: resolution.treasury.id,
          errorCode: error.code,
        },
        'Operational treasury replenish already in flight; continuing wallet funding',
      );
      return;
    }
    throw error;
  }
}
