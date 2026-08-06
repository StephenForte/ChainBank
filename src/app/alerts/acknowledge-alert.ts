import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import { TREASURY_FINDING_ALERT_TYPE } from './notify-treasury-finding.js';
import type { AlertRepository, AuditEventRepository, StoredAlert } from '../ports.js';

/** Maximum length of an acknowledgement note (UTF-16 code units). */
export const MAX_ACKNOWLEDGEMENT_NOTE_LENGTH = 2000;

export interface AcknowledgeAlertDependencies {
  readonly alerts: AlertRepository;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
}

export interface AcknowledgeAlertInput {
  readonly role: Role;
  readonly alertId: string;
  readonly note: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
}

/**
 * Records an operator acknowledgement of an open treasury_finding alert (C20).
 *
 * Sets `state = 'acknowledged'` — never `resolved`. The note is required: an
 * acknowledgement without a stated reason is deletion with extra steps. Does
 * not mutate `reconciliation_runs.findings_json` or any finding severity.
 */
export async function acknowledgeAlert(
  dependencies: AcknowledgeAlertDependencies,
  input: AcknowledgeAlertInput,
): Promise<StoredAlert> {
  assertPermission(input.role, 'alert:acknowledge');

  const note = input.note.trim();
  if (note.length === 0) {
    throw new ChainBankError('INVALID_REQUEST', 'Acknowledgement note must be non-empty', {
      publicMessage: 'Acknowledgement note is required.',
    });
  }
  if (note.length > MAX_ACKNOWLEDGEMENT_NOTE_LENGTH) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Acknowledgement note exceeds ${String(MAX_ACKNOWLEDGEMENT_NOTE_LENGTH)} characters`,
      {
        publicMessage: `Acknowledgement note must be at most ${String(MAX_ACKNOWLEDGEMENT_NOTE_LENGTH)} characters.`,
      },
    );
  }

  const existing = await dependencies.alerts.findById(input.alertId);
  if (existing === undefined) {
    throw new ChainBankError('ALERT_NOT_FOUND', `Alert ${input.alertId} does not exist`, {
      publicMessage: 'Alert not found.',
    });
  }

  if (existing.alertType !== TREASURY_FINDING_ALERT_TYPE) {
    throw new ChainBankError(
      'INVALID_STATUS_TRANSITION',
      `Alert ${input.alertId} is type ${existing.alertType}; only treasury_finding can be acknowledged`,
      {
        publicMessage: 'Only treasury finding alerts can be acknowledged.',
        context: { alertId: input.alertId, alertType: existing.alertType },
      },
    );
  }

  if (existing.state !== 'open') {
    throw new ChainBankError(
      'INVALID_STATUS_TRANSITION',
      `Alert ${input.alertId} is ${existing.state} and cannot be acknowledged`,
      {
        publicMessage: 'Only an open alert can be acknowledged.',
        context: { alertId: input.alertId, state: existing.state },
      },
    );
  }

  const now = dependencies.clock.now();
  const acknowledged = await dependencies.alerts.recordOperatorAcknowledgement({
    id: input.alertId,
    acknowledgedAt: now,
    acknowledgedBy: input.actorId,
    acknowledgementNote: note,
    lastEvaluatedAt: now,
  });

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: 'treasury.alert.acknowledged',
    entityType: 'alert',
    entityId: acknowledged.id,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    metadata: {
      alertType: acknowledged.alertType,
      entityType: acknowledged.entityType,
      findingEntityId: acknowledged.entityId,
      note,
      previousState: 'open',
      nextState: 'acknowledged',
    },
  });

  return acknowledged;
}
