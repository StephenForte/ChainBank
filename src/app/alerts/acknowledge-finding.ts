import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import { isUniqueViolation } from '../../shared/postgres-error.js';
import type { AlertRepository, OperatorMutationTransaction, StoredAlert } from '../ports.js';
import { MAX_ACKNOWLEDGEMENT_NOTE_LENGTH } from './acknowledge-alert.js';
import { TREASURY_FINDING_ALERT_TYPE, TREASURY_FINDING_ENTITY_TYPE } from './notify-treasury-finding.js';

/** Maximum length of a finding alert entity id (tx hash or condition key). */
export const MAX_FINDING_ENTITY_ID_LENGTH = 200;

/** A 32-byte transaction hash — the only finding key C18 lowercases. */
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Normalise a finding identity the way {@link treasuryFindingAlertEntityId}
 * builds it: transaction hashes are lowercased at the source, condition keys
 * are **not** — `outgoing_scan_incomplete:<treasuryId>:<errorCode>` keeps the
 * errorCode's case (`RPC_UNAVAILABLE`).
 *
 * Lowercasing unconditionally is a silent-failure bug, not a cosmetic one. The
 * repository matches `entity_id` exactly, so a lowercased condition key misses
 * the real open row, falls through to `insertOpen`, and creates a *second*
 * acknowledged row under an id nothing else uses — leaving the original alert
 * open and its critical finding on screen behind a 200 response.
 */
export function normaliseFindingEntityId(raw: string): string {
  const trimmed = raw.trim();
  return TRANSACTION_HASH_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface AcknowledgeFindingDependencies {
  readonly operatorMutations: OperatorMutationTransaction;
  readonly clock: Clock;
}

export interface AcknowledgeFindingInput {
  readonly role: Role;
  /**
   * C18 finding identity: lowercase tx hash, or
   * `outgoing_scan_incomplete:<treasuryId>:<errorCode>`.
   */
  readonly entityId: string;
  readonly note: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
  /**
   * Forensic fields for the persist-only open row when none exists yet.
   * Ignored when an open alert is already present.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Acknowledges a critical reconciliation finding by its C18 entity identity
 * (C20 finding-identity path).
 *
 * Unlike {@link acknowledgeAlert}, this works when no alert row exists yet —
 * the common case for findings that predate TX.15 alerting, or when an alert
 * insert failed. Creates an `open` row (persist-only, **no email**) and
 * transitions it to `acknowledged` in one {@link OperatorMutationTransaction}
 * so a partial failure cannot leave a bare open alert (C21).
 *
 * When an open row already exists for the entity, acknowledges that row
 * rather than inserting a second (TX.19 partial unique index).
 */
export async function acknowledgeFinding(
  dependencies: AcknowledgeFindingDependencies,
  input: AcknowledgeFindingInput,
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

  const entityId = normaliseFindingEntityId(input.entityId);
  if (entityId.length === 0) {
    throw new ChainBankError('INVALID_REQUEST', 'Finding entityId must be non-empty', {
      publicMessage: 'Finding entity id is required.',
    });
  }
  if (entityId.length > MAX_FINDING_ENTITY_ID_LENGTH) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Finding entityId exceeds ${String(MAX_FINDING_ENTITY_ID_LENGTH)} characters`,
      {
        publicMessage: `Finding entity id must be at most ${String(MAX_FINDING_ENTITY_ID_LENGTH)} characters.`,
      },
    );
  }

  return dependencies.operatorMutations.run(async (uow) => {
    const now = dependencies.clock.now();
    const openAlertId = await resolveOpenAlertId(uow.alerts, entityId, now, input.metadata);

    const acknowledged = await uow.alerts.recordOperatorAcknowledgement({
      id: openAlertId,
      acknowledgedAt: now,
      acknowledgedBy: input.actorId,
      acknowledgementNote: note,
      lastEvaluatedAt: now,
    });

    await uow.auditEvents.record({
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
        acknowledgementPath: 'finding-identity',
      },
    });

    return acknowledged;
  });
}

async function resolveOpenAlertId(
  alerts: AlertRepository,
  entityId: string,
  now: Date,
  metadata: Readonly<Record<string, unknown>> | undefined,
): Promise<string> {
  const existing = await alerts.findOpenOrAcknowledgedByEntity(
    TREASURY_FINDING_ENTITY_TYPE,
    entityId,
    TREASURY_FINDING_ALERT_TYPE,
  );

  if (existing !== undefined && existing.state === 'open') {
    return existing.id;
  }

  if (existing !== undefined && existing.state === 'acknowledged') {
    throw alreadyAcknowledgedError(entityId, existing.id);
  }

  // No row — persist-only open (no email). pendingEmail satisfies
  // InsertOpenAlertInput and is cleared by recordOperatorAcknowledgement in
  // the same transaction before commit, so nothing email-worthy is durable.
  const rowMetadata: Record<string, unknown> = {
    findingEntityId: entityId,
    ...(metadata ?? {}),
    createdBy: 'operator-acknowledgement',
  };

  try {
    const opened = await alerts.insertOpen({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId,
      firstTriggeredAt: now,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata: rowMetadata,
    });
    return opened.id;
  } catch (error) {
    // TX.19: another writer opened first — adopt rather than create a second.
    if (isUniqueViolation(error)) {
      const winner = await alerts.findOpenOrAcknowledgedByEntity(
        TREASURY_FINDING_ENTITY_TYPE,
        entityId,
        TREASURY_FINDING_ALERT_TYPE,
      );
      if (winner !== undefined && winner.state === 'open') {
        return winner.id;
      }
      if (winner !== undefined && winner.state === 'acknowledged') {
        throw alreadyAcknowledgedError(entityId, winner.id);
      }
    }
    throw error;
  }
}

function alreadyAcknowledgedError(entityId: string, alertId: string): ChainBankError {
  return new ChainBankError('INVALID_STATUS_TRANSITION', `Finding ${entityId} is already acknowledged`, {
    publicMessage: 'Only an open finding alert can be acknowledged.',
    context: { findingEntityId: entityId, alertId, state: 'acknowledged' },
  });
}
