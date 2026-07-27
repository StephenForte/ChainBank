import { describeUnknownError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import type { BalanceReader, ServiceHeartbeat, ServiceHeartbeatRepository } from '../ports.js';

export type ComponentStatus = 'ok' | 'degraded' | 'failed';

export interface ReadinessComponent {
  readonly name: 'database' | 'rpc';
  readonly status: ComponentStatus;
  readonly detail: string | undefined;
}

export interface ReadinessResult {
  readonly status: ComponentStatus;
  readonly checkedAt: Date;
  readonly components: readonly ReadinessComponent[];
  readonly heartbeats: readonly ServiceHeartbeat[];
}

export interface CheckReadinessDependencies {
  readonly serviceHeartbeats: ServiceHeartbeatRepository;
  readonly balanceReader: BalanceReader;
  readonly clock: Clock;
}

/**
 * Reports whether the process can serve requests.
 *
 * The database is required: without it nothing can be durably recorded. The RPC
 * endpoint is only degrading, because status pages and history remain useful
 * and correct while the chain is unreachable.
 */
export async function checkReadiness(
  dependencies: CheckReadinessDependencies,
): Promise<ReadinessResult> {
  const [database, rpc] = await Promise.all([checkDatabase(dependencies), checkRpc(dependencies)]);

  const status: ComponentStatus =
    database.component.status === 'failed'
      ? 'failed'
      : rpc.status === 'failed'
        ? 'degraded'
        : 'ok';

  return {
    status,
    checkedAt: dependencies.clock.now(),
    components: [database.component, rpc],
    heartbeats: database.heartbeats,
  };
}

async function checkDatabase(
  dependencies: CheckReadinessDependencies,
): Promise<{ component: ReadinessComponent; heartbeats: readonly ServiceHeartbeat[] }> {
  try {
    const heartbeats = await dependencies.serviceHeartbeats.list();
    return {
      component: { name: 'database', status: 'ok', detail: undefined },
      heartbeats,
    };
  } catch (error) {
    return {
      component: {
        name: 'database',
        status: 'failed',
        detail: describeUnknownError(error),
      },
      heartbeats: [],
    };
  }
}

async function checkRpc(dependencies: CheckReadinessDependencies): Promise<ReadinessComponent> {
  const verification = await dependencies.balanceReader.verifyChainId();
  if (verification.matches) {
    return { name: 'rpc', status: 'ok', detail: undefined };
  }
  return {
    name: 'rpc',
    status: 'failed',
    detail:
      verification.observedChainId === undefined
        ? 'The RPC endpoint is unreachable.'
        : `The RPC endpoint reports chain ${String(verification.observedChainId)}.`,
  };
}
