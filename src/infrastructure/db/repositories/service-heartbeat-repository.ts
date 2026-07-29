import { asc } from 'drizzle-orm';
import type { ServiceHeartbeat, ServiceHeartbeatRepository } from '../../../app/ports.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { serviceHeartbeats } from '../schema.js';

export function createServiceHeartbeatRepository(db: Database): ServiceHeartbeatRepository {
  return {
    async upsert(input): Promise<void> {
      await withDatabaseErrors('service_heartbeats.upsert', async () => {
        await db
          .insert(serviceHeartbeats)
          .values({
            serviceRole: input.serviceRole,
            lastSeenAt: input.lastSeenAt,
            lastOperationId: input.lastOperationId ?? null,
            detail: input.detail,
          })
          .onConflictDoUpdate({
            target: serviceHeartbeats.serviceRole,
            set: {
              lastSeenAt: input.lastSeenAt,
              lastOperationId: input.lastOperationId ?? null,
              detail: input.detail,
            },
          });
      });
    },

    async list(): Promise<readonly ServiceHeartbeat[]> {
      return withDatabaseErrors('service_heartbeats.list', async () => {
        const rows = await db.select().from(serviceHeartbeats).orderBy(asc(serviceHeartbeats.serviceRole));
        return rows.map((row) => ({
          serviceRole: row.serviceRole,
          lastSeenAt: row.lastSeenAt,
          lastOperationId: row.lastOperationId ?? undefined,
        }));
      });
    },
  };
}
