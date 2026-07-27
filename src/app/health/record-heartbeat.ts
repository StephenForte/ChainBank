import type { Clock } from '../../domain/ports.js';
import type { ServiceHeartbeatRepository } from '../ports.js';

export interface RecordHeartbeatDependencies {
  readonly serviceHeartbeats: ServiceHeartbeatRepository;
  readonly clock: Clock;
}

export interface RecordHeartbeatInput {
  readonly serviceRole: string;
  readonly operationId: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Writes this process's health-check row.
 *
 * Each process writes its own row and can read the others', which is how the
 * web service and the cron job demonstrate they are bound to one database.
 */
export async function recordHeartbeat(
  dependencies: RecordHeartbeatDependencies,
  input: RecordHeartbeatInput,
): Promise<void> {
  await dependencies.serviceHeartbeats.upsert({
    serviceRole: input.serviceRole,
    lastSeenAt: dependencies.clock.now(),
    lastOperationId: input.operationId,
    detail: input.detail,
  });
}
