import { assertNever } from '../../domain/funding/statuses.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { isUniqueViolation } from '../../shared/postgres-error.js';
import { renderTreasuryFindingEmail } from '../email/treasury-finding-template.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailSender,
  ReconciliationFinding,
  StoredOpenAlert,
  Treasury,
} from '../ports.js';
import { TREASURY_ALERT_ENTITY_TYPE } from './evaluate-treasury-alerts.js';

/**
 * Alert type for critical reconciliation findings (TX.15 / C18). Distinct from
 * balance, reserve, and reconciliation_failure so all may coexist (TX.6).
 */
export const TREASURY_FINDING_ALERT_TYPE = 'treasury_finding';

/**
 * Entity type for finding-keyed identity. Unlike C3a/C10/C15 (entity = treasury),
 * the open-alert key is the finding itself so a second distinct incident is not
 * deduped into silence while the first remains open.
 */
export const TREASURY_FINDING_ENTITY_TYPE = 'treasury_finding';

export type CriticalReconciliationFinding = Extract<ReconciliationFinding, { severity: 'critical' }>;

export interface NotifyTreasuryFindingDependencies {
  readonly alerts: AlertRepository;
  /** When absent, the alert is still persisted with pendingEmail for later retry. */
  readonly emailSender: EmailSender | undefined;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface NotifyTreasuryFindingInput {
  readonly finding: CriticalReconciliationFinding;
  readonly treasury: Treasury;
  readonly runId: string;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
  readonly operationId: string;
  readonly actor: {
    readonly type: 'api_credential' | 'cron';
    readonly id: string;
  };
}

export type NotifyTreasuryFindingResult =
  | { readonly kind: 'opened'; readonly alertId: string; readonly email: 'sent' | 'failed' }
  | { readonly kind: 'deduped'; readonly alertId: string }
  | { readonly kind: 'retried'; readonly alertId: string; readonly email: 'sent' | 'failed' };

/**
 * Stable open-alert identity for a critical finding (C18).
 *
 * Unexplained transfers key on the transaction hash so re-observation of the
 * same transfer dedupes, while a second distinct transfer opens a new alert.
 * Scan-incomplete findings key on treasury + error code (no tx hash).
 */
export function treasuryFindingAlertEntityId(finding: CriticalReconciliationFinding): string {
  switch (finding.kind) {
    case 'unexplained_outgoing_transfer':
      return finding.transactionHash.toLowerCase();
    case 'outgoing_scan_incomplete':
      return `outgoing_scan_incomplete:${finding.treasuryId}:${finding.errorCode}`;
    default:
      return assertNever(finding, 'treasuryFindingAlertEntityId');
  }
}

export function isCriticalReconciliationFinding(
  finding: ReconciliationFinding,
): finding is CriticalReconciliationFinding {
  return finding.severity === 'critical';
}

/**
 * Log payload for a critical finding. Every numeric blockchain quantity is a
 * string so Pino / JSON.stringify cannot throw on bigint (TX.11).
 */
export function criticalFindingLogFields(
  finding: CriticalReconciliationFinding,
): Readonly<Record<string, string | number | undefined>> {
  switch (finding.kind) {
    case 'unexplained_outgoing_transfer':
      return {
        kind: finding.kind,
        severity: finding.severity,
        treasuryId: finding.treasuryId,
        transactionHash: finding.transactionHash,
        toAddress: finding.toAddress,
        valueWei: finding.valueWei,
        nonce: finding.nonce,
        blockNumber: finding.blockNumber,
      };
    case 'outgoing_scan_incomplete':
      return {
        kind: finding.kind,
        severity: finding.severity,
        treasuryId: finding.treasuryId,
        errorCode: finding.errorCode,
        reason: finding.reason,
      };
    default:
      return assertNever(finding, 'criticalFindingLogFields');
  }
}

/**
 * Emits one `logger.error` line per critical finding with the full forensic
 * payload. Independent of email — worth shipping alone (TX.15).
 */
export function logCriticalReconciliationFindings(
  logger: Logger,
  input: {
    readonly findings: readonly ReconciliationFinding[];
    readonly correlationId: string;
    readonly runId: string;
  },
): void {
  for (const finding of input.findings) {
    if (!isCriticalReconciliationFinding(finding)) {
      continue;
    }
    const fields = criticalFindingLogFields(finding);
    logger.error(
      {
        event: 'reconciliation.critical_finding',
        correlationId: input.correlationId,
        runId: input.runId,
        ...fields,
      },
      'Critical reconciliation finding recorded',
    );
  }
}

/**
 * Persist-then-send a critical finding alert (PRD P4-US3 companion / C18).
 *
 * C18 routes two natures through `treasury_finding` (C20 amendment):
 * - **Event** (`unexplained_outgoing_transfer`): immutable; acknowledgement
 *   suppresses re-observation of the same hash forever.
 * - **Condition** (`outgoing_scan_incomplete`): recurring; acknowledgement
 *   must not permanently silence a later re-observation of the same
 *   `(treasury, errorCode)` key — the detector is dark while the condition
 *   persists. Re-observation opens a new row and leaves the acknowledged
 *   record (note + actor) intact.
 */
export async function notifyTreasuryFinding(
  dependencies: NotifyTreasuryFindingDependencies,
  input: NotifyTreasuryFindingInput,
): Promise<NotifyTreasuryFindingResult> {
  const entityId = treasuryFindingAlertEntityId(input.finding);
  const now = dependencies.clock.now();
  const metadata = findingMetadata(input);

  if (input.operatorRecipients.length === 0) {
    dependencies.logger.warn(
      {
        event: 'treasury.finding_alert.no_recipients',
        treasuryId: input.treasury.id,
        findingEntityId: entityId,
        operationId: input.operationId,
      },
      'Treasury finding alert cannot send: no operator recipients configured',
    );
  }

  // Prefer open over acknowledged when both exist for the same entityId (C20).
  const existing = await dependencies.alerts.findOpenOrAcknowledgedByEntity(
    TREASURY_FINDING_ENTITY_TYPE,
    entityId,
    TREASURY_FINDING_ALERT_TYPE,
  );

  if (existing === undefined) {
    return openAndSendFindingAlert(dependencies, input, entityId, now, metadata);
  }

  if (existing.state === 'acknowledged') {
    // Event: ack sticks. Condition: open a new row; do not flip or overwrite
    // the prior acknowledgement note (append-oriented incident record).
    if (input.finding.kind === 'unexplained_outgoing_transfer') {
      return { kind: 'deduped', alertId: existing.id };
    }
    return openAndSendFindingAlert(dependencies, input, entityId, now, metadata);
  }

  if (existing.pendingEmail !== undefined) {
    const pending = await dependencies.alerts.markPendingEmail({
      id: existing.id,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });
    const email = await sendFindingEmail(dependencies, input, pending);
    return { kind: 'retried', alertId: pending.id, email };
  }

  await dependencies.alerts.touchLastEvaluated({
    id: existing.id,
    lastEvaluatedAt: now,
    metadata,
  });
  return { kind: 'deduped', alertId: existing.id };
}

async function openAndSendFindingAlert(
  dependencies: NotifyTreasuryFindingDependencies,
  input: NotifyTreasuryFindingInput,
  entityId: string,
  now: Date,
  metadata: Readonly<Record<string, unknown>>,
): Promise<Extract<NotifyTreasuryFindingResult, { kind: 'opened' | 'deduped' }>> {
  try {
    const opened = await dependencies.alerts.insertOpen({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId,
      firstTriggeredAt: now,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });
    const email = await sendFindingEmail(dependencies, input, opened);
    return { kind: 'opened', alertId: opened.id, email };
  } catch (error) {
    // Partial unique index (TX.19): another writer opened first. Adopt via the
    // same C20 lookup this path uses — never throw, or the finding is lost.
    if (isUniqueViolation(error)) {
      const winner = await dependencies.alerts.findOpenOrAcknowledgedByEntity(
        TREASURY_FINDING_ENTITY_TYPE,
        entityId,
        TREASURY_FINDING_ALERT_TYPE,
      );
      if (winner !== undefined) {
        return { kind: 'deduped', alertId: winner.id };
      }
    }
    throw error;
  }
}

function findingMetadata(input: NotifyTreasuryFindingInput): Readonly<Record<string, unknown>> {
  const { finding } = input;
  const base = {
    findingKind: finding.kind,
    treasuryId: finding.treasuryId,
    runId: input.runId,
    findingEntityId: treasuryFindingAlertEntityId(finding),
  };

  switch (finding.kind) {
    case 'unexplained_outgoing_transfer':
      return {
        ...base,
        transactionHash: finding.transactionHash,
        toAddress: finding.toAddress,
        valueWei: finding.valueWei,
        nonce: finding.nonce,
        blockNumber: finding.blockNumber,
      };
    case 'outgoing_scan_incomplete':
      return {
        ...base,
        errorCode: finding.errorCode,
        reason: finding.reason,
      };
    default:
      return assertNever(finding, 'findingMetadata');
  }
}

function explorerTxUrl(treasury: Treasury, transactionHash: string | undefined): string | undefined {
  if (transactionHash === undefined) {
    return undefined;
  }
  const base = treasury.chain.explorerBaseUrl.replace(/\/$/u, '');
  return `${base}/tx/${transactionHash}`;
}

async function sendFindingEmail(
  dependencies: NotifyTreasuryFindingDependencies,
  input: NotifyTreasuryFindingInput,
  alert: StoredOpenAlert,
): Promise<'sent' | 'failed'> {
  if (dependencies.emailSender === undefined || input.operatorRecipients.length === 0) {
    await dependencies.auditEvents.record({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'treasury.alert.email.failed',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: input.treasury.id,
      requestId: input.operationId,
      sourceIp: undefined,
      metadata: {
        transition: 'open',
        pendingEmail: 'critical',
        alertType: TREASURY_FINDING_ALERT_TYPE,
        alertId: alert.id,
        findingEntityId: alert.entityId,
        errorCode: 'EMAIL_PROVIDER_UNAVAILABLE',
        reason:
          dependencies.emailSender === undefined ? 'email-sender-unavailable' : 'no-operator-recipients',
      },
    });
    return 'failed';
  }

  const finding = input.finding;
  const transactionHash =
    finding.kind === 'unexplained_outgoing_transfer' ? finding.transactionHash : undefined;

  const rendered = renderTreasuryFindingEmail({
    environment: input.environment,
    chainDisplayName: input.treasury.chain.displayName,
    treasuryAddressDisplay: input.treasury.addressDisplay,
    treasuryId: input.treasury.id,
    findingKind: finding.kind,
    transactionHash,
    toAddress: finding.kind === 'unexplained_outgoing_transfer' ? finding.toAddress : undefined,
    valueWei: finding.kind === 'unexplained_outgoing_transfer' ? finding.valueWei : undefined,
    nonce: finding.kind === 'unexplained_outgoing_transfer' ? finding.nonce : undefined,
    blockNumber: finding.kind === 'unexplained_outgoing_transfer' ? finding.blockNumber : undefined,
    errorCode: finding.kind === 'outgoing_scan_incomplete' ? finding.errorCode : undefined,
    reason: finding.kind === 'outgoing_scan_incomplete' ? finding.reason : undefined,
    explorerTxUrl: explorerTxUrl(input.treasury, transactionHash),
    dashboardBaseUrl: input.dashboardBaseUrl,
  });

  const result = await dependencies.emailSender.send({
    to: input.operatorRecipients,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  if (result.kind === 'failed') {
    await dependencies.auditEvents.record({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'treasury.alert.email.failed',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: input.treasury.id,
      requestId: input.operationId,
      sourceIp: undefined,
      metadata: {
        transition: 'open',
        pendingEmail: 'critical',
        alertType: TREASURY_FINDING_ALERT_TYPE,
        alertId: alert.id,
        findingEntityId: alert.entityId,
        errorCode: result.errorCode,
      },
    });
    return 'failed';
  }

  const now = dependencies.clock.now();
  await dependencies.alerts.acknowledgeSend({
    id: alert.id,
    lastSentAt: now,
    lastEvaluatedAt: now,
  });

  await dependencies.auditEvents.record({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: 'treasury.alert.email.sent',
    entityType: TREASURY_ALERT_ENTITY_TYPE,
    entityId: input.treasury.id,
    requestId: input.operationId,
    sourceIp: undefined,
    metadata: {
      transition: 'open',
      pendingEmail: 'critical',
      alertType: TREASURY_FINDING_ALERT_TYPE,
      alertId: alert.id,
      findingEntityId: alert.entityId,
      findingKind: finding.kind,
      transactionHash,
    },
  });

  return 'sent';
}
