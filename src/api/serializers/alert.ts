import type { StoredAlert } from '../../app/ports.js';

/**
 * Wire shape for an alert (C20).
 *
 * Metadata is unvalidated at rest across alert writers — pass through as an
 * opaque record so forensic fields from finding alerts still appear.
 */
export interface AlertResource {
  readonly id: string;
  readonly alertType: string;
  readonly severity: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly state: string;
  readonly firstTriggeredAt: string;
  readonly lastEvaluatedAt: string;
  readonly lastSentAt: string | null;
  readonly resolvedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgementNote: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function serializeAlert(alert: StoredAlert): AlertResource {
  return {
    id: alert.id,
    alertType: alert.alertType,
    severity: alert.severity,
    entityType: alert.entityType,
    entityId: alert.entityId,
    state: alert.state,
    firstTriggeredAt: alert.firstTriggeredAt.toISOString(),
    lastEvaluatedAt: alert.lastEvaluatedAt.toISOString(),
    lastSentAt: alert.lastSentAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: alert.acknowledgedBy ?? null,
    acknowledgementNote: alert.acknowledgementNote ?? null,
    metadata: { ...alert.metadata },
  };
}
