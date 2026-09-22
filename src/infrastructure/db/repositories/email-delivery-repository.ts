import { and, count, desc, eq } from 'drizzle-orm';
import type {
  EmailDeliveryListFilters,
  EmailDeliveryListPage,
  EmailDeliveryRepository,
  RecordEmailDeliveryInput,
  StoredEmailDelivery,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { emailDeliveries, type EmailDeliveryRow } from '../schema.js';

export function createEmailDeliveryRepository(db: Database): EmailDeliveryRepository {
  return {
    async record(input: RecordEmailDeliveryInput): Promise<void> {
      await withDatabaseErrors('email_deliveries.record', async () => {
        await db.insert(emailDeliveries).values({
          sentAt: input.sentAt,
          kind: input.kind,
          recipients: [...input.recipients],
          subject: input.subject,
          status: input.status,
          providerMessageId: input.providerMessageId ?? null,
          errorCode: input.errorCode ?? null,
          errorSummary: input.errorSummary ?? null,
          relatedEntityType: input.relatedEntityType ?? null,
          relatedEntityId: input.relatedEntityId ?? null,
          correlationId: input.correlationId ?? null,
          serviceRole: input.serviceRole,
        });
      });
    },

    async list(filters: EmailDeliveryListFilters): Promise<EmailDeliveryListPage> {
      return withDatabaseErrors('email_deliveries.list', async () => {
        if (!Number.isInteger(filters.limit) || filters.limit < 1) {
          throw new ChainBankError(
            'INVALID_REQUEST',
            `list limit must be a positive integer; got ${String(filters.limit)}`,
          );
        }
        if (!Number.isInteger(filters.offset) || filters.offset < 0) {
          throw new ChainBankError(
            'INVALID_REQUEST',
            `list offset must be a non-negative integer; got ${String(filters.offset)}`,
          );
        }

        const conditions = [];
        if (filters.status !== undefined) {
          conditions.push(eq(emailDeliveries.status, filters.status));
        }
        if (filters.kind !== undefined) {
          conditions.push(eq(emailDeliveries.kind, filters.kind));
        }
        const where = conditions.length === 0 ? undefined : and(...conditions);

        const [totalRow] = await db.select({ value: count() }).from(emailDeliveries).where(where);
        const rows = await db
          .select()
          .from(emailDeliveries)
          .where(where)
          .orderBy(desc(emailDeliveries.sentAt), desc(emailDeliveries.id))
          .limit(filters.limit)
          .offset(filters.offset);

        return {
          items: rows.map(toStoredEmailDelivery),
          total: totalRow?.value ?? 0,
        };
      });
    },
  };
}

function toStoredEmailDelivery(row: EmailDeliveryRow): StoredEmailDelivery {
  return {
    id: row.id,
    sentAt: row.sentAt,
    kind: row.kind,
    recipients: row.recipients,
    subject: row.subject,
    status: row.status,
    providerMessageId: row.providerMessageId ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorSummary: row.errorSummary ?? undefined,
    relatedEntityType: row.relatedEntityType ?? undefined,
    relatedEntityId: row.relatedEntityId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    serviceRole: row.serviceRole,
    createdAt: row.createdAt,
  };
}
