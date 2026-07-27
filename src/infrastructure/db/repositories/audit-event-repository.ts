import type { AuditEventInput, AuditEventRepository } from '../../../app/ports.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { auditEvents } from '../schema.js';

export function createAuditEventRepository(db: Database): AuditEventRepository {
  return {
    async record(input: AuditEventInput): Promise<void> {
      await withDatabaseErrors('audit_events.record', async () => {
        await db.insert(auditEvents).values({
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          requestId: input.requestId ?? null,
          sourceIp: input.sourceIp ?? null,
          metadata: input.metadata,
        });
      });
    },
  };
}
