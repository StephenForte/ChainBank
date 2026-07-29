import {
  applyAlertTransition,
  evaluateTreasuryAlert,
  type AlertSeverity,
  type AlertTransition,
  type OpenAlertState,
} from '../../domain/alerts/index.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import { renderTreasuryCriticalEmail } from '../email/treasury-critical-template.js';
import { renderTreasuryRecoveryEmail } from '../email/treasury-recovery-template.js';
import { renderTreasuryUnresolvedReminderEmail } from '../email/treasury-unresolved-reminder-template.js';
import { renderTreasuryWarningEmail } from '../email/treasury-warning-template.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailSender,
  PendingAlertEmail,
  StoredOpenAlert,
  Treasury,
} from '../ports.js';

export const TREASURY_BALANCE_ALERT_TYPE = 'treasury_balance';
export const TREASURY_ALERT_ENTITY_TYPE = 'treasury';

export interface EvaluateTreasuryAlertsDependencies {
  readonly alerts: AlertRepository;
  readonly emailSender: EmailSender;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
}

export interface EvaluateTreasuryAlertsInput {
  readonly treasury: Treasury;
  readonly balanceWei: bigint;
  readonly reminderIntervalMs: number;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
  readonly operationId: string;
  readonly actor:
    { readonly type: 'api_credential'; readonly id: string } | { readonly type: 'cron'; readonly id: string };
}

export type EvaluateTreasuryAlertsEmailOutcome =
  | { readonly kind: 'not-required' }
  | {
      readonly kind: 'sent';
      readonly pendingEmail: PendingAlertEmail;
      readonly providerMessageId: string | undefined;
    }
  | {
      readonly kind: 'failed';
      readonly pendingEmail: PendingAlertEmail;
      readonly errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_PROVIDER_REJECTED';
      readonly reason: string;
    };

export interface EvaluateTreasuryAlertsResult {
  readonly transition: AlertTransition;
  readonly email: EvaluateTreasuryAlertsEmailOutcome;
  readonly openAlert: StoredOpenAlert | undefined;
}

/**
 * Evaluates treasury alert transitions after a successful balance observation.
 *
 * Shared by the treasury-monitor cron and the manual check-now path so recovery
 * is detected without a separate resume action (PRD P3-US3). Persist-then-send:
 * structural alert state and `pendingEmail` are written before the provider
 * call; `last_sent_at` advances (or the row resolves) only after a successful
 * send. A failed send leaves `pendingEmail` set so the next run retries the
 * same email rather than losing or duplicating it.
 */
export async function evaluateTreasuryAlerts(
  dependencies: EvaluateTreasuryAlertsDependencies,
  input: EvaluateTreasuryAlertsInput,
): Promise<EvaluateTreasuryAlertsResult> {
  if (input.operatorRecipients.length === 0) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'evaluateTreasuryAlerts requires at least one operator recipient',
      { publicMessage: 'Alert email recipients are not configured.' },
    );
  }

  const now = dependencies.clock.now();
  const existing = await dependencies.alerts.findOpenByEntity(TREASURY_ALERT_ENTITY_TYPE, input.treasury.id);

  const openAlertState = toOpenAlertState(existing);
  let transition = evaluateTreasuryAlert({
    balanceWei: input.balanceWei,
    thresholds: input.treasury.thresholds,
    openAlert: openAlertState,
    now,
    reminderIntervalMs: input.reminderIntervalMs,
  });

  // A prior persist-then-send left pendingEmail without advancing last_sent_at.
  // When the balance band has not produced a new transition, retry that email
  // — except a stale recovery intent after the balance dipped again.
  if (transition.kind === 'none' && existing?.pendingEmail !== undefined) {
    if (existing.pendingEmail === 'recovery') {
      const cleared = await dependencies.alerts.clearPendingEmail({
        id: existing.id,
        lastEvaluatedAt: now,
      });
      return { transition, email: { kind: 'not-required' }, openAlert: cleared };
    }
    transition = transitionFromPendingEmail(existing.pendingEmail, existing.severity);
  }

  if (transition.kind === 'none') {
    if (existing !== undefined) {
      await dependencies.alerts.touchLastEvaluated({ id: existing.id, lastEvaluatedAt: now });
    }
    return { transition, email: { kind: 'not-required' }, openAlert: existing };
  }

  const pendingEmail = pendingEmailForTransition(transition);
  const persisted = await persistTransition(dependencies.alerts, {
    existing,
    transition,
    pendingEmail,
    now,
    treasuryId: input.treasury.id,
  });

  const sendResult = await sendTransitionEmail(dependencies.emailSender, {
    transition,
    pendingEmail,
    severityForReminder: persisted.severity,
    firstTriggeredAt: persisted.firstTriggeredAt,
    input,
  });

  if (sendResult.kind === 'failed') {
    await dependencies.auditEvents.record({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'treasury.alert.email.failed',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: input.treasury.id,
      requestId: input.operationId,
      sourceIp: undefined,
      metadata: {
        transition: transition.kind,
        pendingEmail,
        alertId: persisted.id,
        errorCode: sendResult.errorCode,
      },
    });

    return {
      transition,
      email: {
        kind: 'failed',
        pendingEmail,
        errorCode: sendResult.errorCode,
        reason: sendResult.reason,
      },
      openAlert: persisted,
    };
  }

  const acknowledged =
    transition.kind === 'resolve'
      ? await dependencies.alerts.resolve({
          id: persisted.id,
          resolvedAt: now,
          lastEvaluatedAt: now,
        })
      : await dependencies.alerts.acknowledgeSend({
          id: persisted.id,
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
      transition: transition.kind,
      pendingEmail,
      alertId: persisted.id,
      balanceWei: input.balanceWei.toString(),
    },
  });

  return {
    transition,
    email: {
      kind: 'sent',
      pendingEmail,
      providerMessageId: sendResult.providerMessageId,
    },
    openAlert: transition.kind === 'resolve' ? undefined : acknowledged,
  };
}

function toOpenAlertState(existing: StoredOpenAlert | undefined): OpenAlertState | undefined {
  if (existing === undefined) {
    return undefined;
  }
  // last_sent_at is null while an open/escalate email is still pending. Using
  // firstTriggeredAt keeps reminder math well-defined without inventing a send.
  return {
    severity: existing.severity,
    firstTriggeredAt: existing.firstTriggeredAt,
    lastSentAt: existing.lastSentAt ?? existing.firstTriggeredAt,
  };
}

function pendingEmailForTransition(transition: AlertTransition): PendingAlertEmail {
  switch (transition.kind) {
    case 'open':
      return transition.severity === 'critical' ? 'critical' : 'warning';
    case 'escalate':
      return 'critical';
    case 'remind':
      return 'reminder';
    case 'resolve':
      return 'recovery';
    case 'none':
      throw new ChainBankError('INTERNAL_ERROR', 'Cannot derive pending email for none transition');
    default: {
      const _exhaustive: never = transition;
      throw new ChainBankError(
        'INTERNAL_ERROR',
        `Unhandled alert transition: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function transitionFromPendingEmail(
  pendingEmail: PendingAlertEmail,
  severity: AlertSeverity,
): AlertTransition {
  switch (pendingEmail) {
    case 'warning':
      return { kind: 'open', severity: 'warning' };
    case 'critical':
      // Escalate may already have written severity=critical before the failed send.
      return severity === 'warning' ? { kind: 'escalate' } : { kind: 'open', severity: 'critical' };
    case 'reminder':
      return { kind: 'remind' };
    case 'recovery':
      return { kind: 'resolve' };
    default: {
      const _exhaustive: never = pendingEmail;
      throw new ChainBankError('INTERNAL_ERROR', `Unhandled pending email: ${String(_exhaustive)}`);
    }
  }
}

async function persistTransition(
  alerts: AlertRepository,
  input: {
    readonly existing: StoredOpenAlert | undefined;
    readonly transition: AlertTransition;
    readonly pendingEmail: PendingAlertEmail;
    readonly now: Date;
    readonly treasuryId: string;
  },
): Promise<StoredOpenAlert> {
  const { existing, transition, pendingEmail, now, treasuryId } = input;

  // applyAlertTransition validates escalate/remind/resolve preconditions.
  applyAlertTransition(
    existing === undefined
      ? undefined
      : {
          severity: existing.severity,
          firstTriggeredAt: existing.firstTriggeredAt,
          lastSentAt: existing.lastSentAt ?? existing.firstTriggeredAt,
        },
    transition,
    now,
  );

  switch (transition.kind) {
    case 'open':
      if (existing !== undefined && existing.pendingEmail !== undefined) {
        // Retry of a failed opening send — row already exists.
        return alerts.markPendingEmail({
          id: existing.id,
          lastEvaluatedAt: now,
          pendingEmail,
        });
      }
      return alerts.insertOpen({
        alertType: TREASURY_BALANCE_ALERT_TYPE,
        severity: transition.severity,
        entityType: TREASURY_ALERT_ENTITY_TYPE,
        entityId: treasuryId,
        firstTriggeredAt: now,
        lastEvaluatedAt: now,
        pendingEmail,
        metadata: {},
      });
    case 'escalate':
      if (existing === undefined) {
        throw new ChainBankError('INTERNAL_ERROR', 'Cannot escalate without an open alert');
      }
      return alerts.markEscalated({
        id: existing.id,
        lastEvaluatedAt: now,
        pendingEmail,
      });
    case 'remind':
    case 'resolve':
      if (existing === undefined) {
        throw new ChainBankError('INTERNAL_ERROR', `Cannot ${transition.kind} without an open alert`);
      }
      return alerts.markPendingEmail({
        id: existing.id,
        lastEvaluatedAt: now,
        pendingEmail,
      });
    case 'none':
      throw new ChainBankError('INTERNAL_ERROR', 'Cannot persist none transition');
    default: {
      const _exhaustive: never = transition;
      throw new ChainBankError(
        'INTERNAL_ERROR',
        `Unhandled alert transition: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

async function sendTransitionEmail(
  emailSender: EmailSender,
  options: {
    readonly transition: AlertTransition;
    readonly pendingEmail: PendingAlertEmail;
    readonly severityForReminder: AlertSeverity;
    readonly firstTriggeredAt: Date;
    readonly input: EvaluateTreasuryAlertsInput;
  },
): Promise<
  | { readonly kind: 'sent'; readonly providerMessageId: string | undefined }
  | {
      readonly kind: 'failed';
      readonly errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_PROVIDER_REJECTED';
      readonly reason: string;
    }
> {
  const { input, pendingEmail, severityForReminder, firstTriggeredAt } = options;
  const common = {
    environment: input.environment,
    chainDisplayName: input.treasury.chain.displayName,
    treasuryAddressDisplay: input.treasury.addressDisplay,
    observedBalanceWei: input.balanceWei,
    dashboardBaseUrl: input.dashboardBaseUrl,
  };

  const rendered = (() => {
    switch (pendingEmail) {
      case 'warning':
        return renderTreasuryWarningEmail({
          ...common,
          warningThresholdWei: input.treasury.thresholds.warningBalanceWei,
        });
      case 'critical':
        return renderTreasuryCriticalEmail({
          ...common,
          criticalThresholdWei: input.treasury.thresholds.criticalBalanceWei,
        });
      case 'reminder':
        return renderTreasuryUnresolvedReminderEmail({
          ...common,
          severity: severityForReminder,
          activeThresholdWei:
            severityForReminder === 'critical'
              ? input.treasury.thresholds.criticalBalanceWei
              : input.treasury.thresholds.warningBalanceWei,
          firstTriggeredAt,
        });
      case 'recovery':
        return renderTreasuryRecoveryEmail({
          ...common,
          recoveryThresholdWei: input.treasury.thresholds.recoveryBalanceWei,
        });
      default: {
        const _exhaustive: never = pendingEmail;
        throw new ChainBankError('INTERNAL_ERROR', `Unhandled pending email: ${String(_exhaustive)}`);
      }
    }
  })();

  const result = await emailSender.send({
    to: input.operatorRecipients,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  if (result.kind === 'failed') {
    return { kind: 'failed', errorCode: result.errorCode, reason: result.reason };
  }
  return { kind: 'sent', providerMessageId: result.providerMessageId };
}
