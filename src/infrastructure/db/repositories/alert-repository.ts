import { and, desc, eq } from 'drizzle-orm';
import type {
  AlertRepository,
  InsertOpenAlertInput,
  PendingAlertEmail,
  StoredOpenAlert,
} from '../../../app/ports.js';
import type { AlertSeverity } from '../../../domain/alerts/treasury-alert.js';
import { ChainBankError } from '../../../domain/errors.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { alerts, type AlertRow } from '../schema.js';

const PENDING_EMAIL_KEY = 'pendingEmail';

const PENDING_EMAIL_VALUES = new Set<PendingAlertEmail>(['warning', 'critical', 'reminder', 'recovery']);

export function createAlertRepository(db: Database): AlertRepository {
  return {
    async findOpenByEntity(entityType, entityId, alertType): Promise<StoredOpenAlert | undefined> {
      return withDatabaseErrors('alerts.findOpenByEntity', async () => {
        const row = await db.query.alerts.findFirst({
          where: and(
            eq(alerts.entityType, entityType),
            eq(alerts.entityId, entityId),
            eq(alerts.alertType, alertType),
            eq(alerts.state, 'open'),
          ),
          orderBy: [desc(alerts.firstTriggeredAt)],
        });
        return row === undefined ? undefined : toStoredOpenAlert(row);
      });
    },

    async insertOpen(input: InsertOpenAlertInput): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.insertOpen', async () => {
        const [row] = await db
          .insert(alerts)
          .values({
            alertType: input.alertType,
            severity: input.severity,
            entityType: input.entityType,
            entityId: input.entityId,
            state: 'open',
            firstTriggeredAt: input.firstTriggeredAt,
            lastEvaluatedAt: input.lastEvaluatedAt,
            lastSentAt: null,
            resolvedAt: null,
            metadataJson: withPendingEmail(input.metadata, input.pendingEmail),
          })
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert insert returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async markEscalated(input): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.markEscalated', async () => {
        const existing = await db.query.alerts.findFirst({
          where: and(eq(alerts.id, input.id), eq(alerts.state, 'open')),
        });
        if (existing === undefined) {
          throw new ChainBankError('INTERNAL_ERROR', `Open alert ${input.id} was not found for escalate`);
        }

        const [row] = await db
          .update(alerts)
          .set({
            severity: 'critical',
            lastEvaluatedAt: input.lastEvaluatedAt,
            metadataJson: withPendingEmail(asMetadataRecord(existing.metadataJson), input.pendingEmail),
          })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert escalate returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async markPendingEmail(input): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.markPendingEmail', async () => {
        const existing = await db.query.alerts.findFirst({
          where: and(eq(alerts.id, input.id), eq(alerts.state, 'open')),
        });
        if (existing === undefined) {
          throw new ChainBankError(
            'INTERNAL_ERROR',
            `Open alert ${input.id} was not found for pending email`,
          );
        }

        const [row] = await db
          .update(alerts)
          .set({
            lastEvaluatedAt: input.lastEvaluatedAt,
            metadataJson: withPendingEmail(asMetadataRecord(existing.metadataJson), input.pendingEmail),
          })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert pending-email update returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async clearPendingEmail(input): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.clearPendingEmail', async () => {
        const existing = await db.query.alerts.findFirst({
          where: and(eq(alerts.id, input.id), eq(alerts.state, 'open')),
        });
        if (existing === undefined) {
          throw new ChainBankError(
            'INTERNAL_ERROR',
            `Open alert ${input.id} was not found for clear pending email`,
          );
        }

        const [row] = await db
          .update(alerts)
          .set({
            lastEvaluatedAt: input.lastEvaluatedAt,
            metadataJson: clearPendingEmail(asMetadataRecord(existing.metadataJson)),
          })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert clear-pending-email returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async acknowledgeSend(input): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.acknowledgeSend', async () => {
        const existing = await db.query.alerts.findFirst({
          where: and(eq(alerts.id, input.id), eq(alerts.state, 'open')),
        });
        if (existing === undefined) {
          throw new ChainBankError(
            'INTERNAL_ERROR',
            `Open alert ${input.id} was not found for send acknowledgement`,
          );
        }

        const [row] = await db
          .update(alerts)
          .set({
            lastSentAt: input.lastSentAt,
            lastEvaluatedAt: input.lastEvaluatedAt,
            metadataJson: clearPendingEmail(asMetadataRecord(existing.metadataJson)),
          })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert acknowledge-send returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async resolve(input): Promise<StoredOpenAlert> {
      return withDatabaseErrors('alerts.resolve', async () => {
        const existing = await db.query.alerts.findFirst({
          where: and(eq(alerts.id, input.id), eq(alerts.state, 'open')),
        });
        if (existing === undefined) {
          throw new ChainBankError('INTERNAL_ERROR', `Open alert ${input.id} was not found for resolve`);
        }

        const [row] = await db
          .update(alerts)
          .set({
            state: 'resolved',
            resolvedAt: input.resolvedAt,
            lastEvaluatedAt: input.lastEvaluatedAt,
            metadataJson: clearPendingEmail(asMetadataRecord(existing.metadataJson)),
          })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('DATABASE_UNAVAILABLE', 'Alert resolve returned no row');
        }
        return toStoredOpenAlert(row);
      });
    },

    async touchLastEvaluated(input): Promise<void> {
      await withDatabaseErrors('alerts.touchLastEvaluated', async () => {
        await db
          .update(alerts)
          .set({ lastEvaluatedAt: input.lastEvaluatedAt })
          .where(and(eq(alerts.id, input.id), eq(alerts.state, 'open')));
      });
    },
  };
}

function toStoredOpenAlert(row: AlertRow): StoredOpenAlert {
  const metadata = asMetadataRecord(row.metadataJson);
  return {
    id: row.id,
    alertType: row.alertType,
    severity: parseSeverity(row.severity),
    entityType: row.entityType,
    entityId: row.entityId,
    firstTriggeredAt: row.firstTriggeredAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    lastSentAt: row.lastSentAt ?? undefined,
    pendingEmail: readPendingEmail(metadata),
    metadata,
  };
}

function parseSeverity(value: string): AlertSeverity {
  if (value === 'warning' || value === 'critical') {
    return value;
  }
  throw new ChainBankError('INTERNAL_ERROR', `Alert row has unsupported severity: ${value}`);
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function readPendingEmail(metadata: Readonly<Record<string, unknown>>): PendingAlertEmail | undefined {
  const value = metadata[PENDING_EMAIL_KEY];
  if (typeof value === 'string' && PENDING_EMAIL_VALUES.has(value as PendingAlertEmail)) {
    return value as PendingAlertEmail;
  }
  return undefined;
}

function withPendingEmail(
  metadata: Readonly<Record<string, unknown>>,
  pendingEmail: PendingAlertEmail,
): Record<string, unknown> {
  return { ...metadata, [PENDING_EMAIL_KEY]: pendingEmail };
}

function clearPendingEmail(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next = { ...metadata };
  delete next[PENDING_EMAIL_KEY];
  return next;
}
