import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import { renderFundingUnavailableReserveEmail } from '../email/funding-unavailable-reserve-template.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailSender,
  StoredOpenAlert,
  Treasury,
} from '../ports.js';
import { TREASURY_ALERT_ENTITY_TYPE, TREASURY_BALANCE_ALERT_TYPE } from './evaluate-treasury-alerts.js';

/**
 * Alert type for reserve-exhaustion (P1-US5). Distinct from
 * {@link TREASURY_BALANCE_ALERT_TYPE} so both may be open on one treasury (C3a).
 */
export const TREASURY_RESERVE_ALERT_TYPE = 'treasury_reserve';

// Re-export so callers can import both treasury alert type constants together.
export { TREASURY_ALERT_ENTITY_TYPE, TREASURY_BALANCE_ALERT_TYPE };

export interface NotifyTreasuryReserveAlertDependencies {
  readonly alerts: AlertRepository;
  /** When absent, the alert is still persisted with pendingEmail for later retry. */
  readonly emailSender: EmailSender | undefined;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface NotifyTreasuryReserveRefusalInput {
  readonly treasury: Treasury;
  readonly treasuryBalanceWei: bigint;
  readonly managedWalletAddressDisplay: string;
  readonly managedWalletId: string;
  /** Deficit toward target, clamped by maximumTopUp — never a misleading zero. */
  readonly requestedAmountWei: bigint;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
  readonly operationId: string;
  readonly actor: {
    readonly type: 'api_credential' | 'cron';
    readonly id: string;
  };
}

export type NotifyTreasuryReserveRefusalResult =
  | { readonly kind: 'opened'; readonly alertId: string; readonly email: 'sent' | 'failed' }
  | { readonly kind: 'deduped'; readonly alertId: string }
  | { readonly kind: 'retried'; readonly alertId: string; readonly email: 'sent' | 'failed' }
  | { readonly kind: 'skipped'; readonly reason: 'non-positive-requested-amount' };

export interface ResolveTreasuryReserveAlertInput {
  readonly treasuryId: string;
  readonly operationId: string;
  readonly actor: {
    readonly type: 'api_credential' | 'cron';
    readonly id: string;
  };
}

export type ResolveTreasuryReserveAlertResult =
  { readonly kind: 'resolved'; readonly alertId: string } | { readonly kind: 'none-open' };

/**
 * Records a treasury-scoped critical alert when funding is refused for reserve
 * (PRD P1-US5). One open `treasury_reserve` alert per treasury: the first
 * refusal persist-then-sends the email; later refusals update
 * `last_evaluated_at` and metadata only (no reminder interval in T1.8).
 *
 * Safe for T2.2 ensure-ready bursts: N wallet refusals against one treasury
 * produce one email, not one per wallet.
 */
export async function notifyTreasuryReserveRefusal(
  dependencies: NotifyTreasuryReserveAlertDependencies,
  input: NotifyTreasuryReserveRefusalInput,
): Promise<NotifyTreasuryReserveRefusalResult> {
  if (input.requestedAmountWei <= 0n) {
    dependencies.logger.warn(
      {
        event: 'treasury.reserve_alert.skipped',
        treasuryId: input.treasury.id,
        operationId: input.operationId,
        reason: 'non-positive-requested-amount',
      },
      'Skipping reserve alert: requested amount is not positive',
    );
    return { kind: 'skipped', reason: 'non-positive-requested-amount' };
  }

  if (input.operatorRecipients.length === 0) {
    dependencies.logger.warn(
      {
        event: 'treasury.reserve_alert.no_recipients',
        treasuryId: input.treasury.id,
        operationId: input.operationId,
      },
      'Reserve alert cannot send: no operator recipients configured',
    );
  }

  const now = dependencies.clock.now();
  const metadata = refusalMetadata(input);
  const existing = await dependencies.alerts.findOpenByEntity(
    TREASURY_ALERT_ENTITY_TYPE,
    input.treasury.id,
    TREASURY_RESERVE_ALERT_TYPE,
  );

  if (existing === undefined) {
    const opened = await dependencies.alerts.insertOpen({
      alertType: TREASURY_RESERVE_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: input.treasury.id,
      firstTriggeredAt: now,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });

    const email = await sendReserveEmail(dependencies, input, opened);
    return { kind: 'opened', alertId: opened.id, email };
  }

  // Failed prior send left pendingEmail — retry without advancing last_sent_at
  // until the provider accepts (same persist-then-send contract as T3.3).
  if (existing.pendingEmail !== undefined) {
    const pending = await dependencies.alerts.markPendingEmail({
      id: existing.id,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });
    const email = await sendReserveEmail(dependencies, input, pending);
    return { kind: 'retried', alertId: pending.id, email };
  }

  await dependencies.alerts.touchLastEvaluated({
    id: existing.id,
    lastEvaluatedAt: now,
    metadata,
  });
  return { kind: 'deduped', alertId: existing.id };
}

/**
 * Resolves an open reserve alert when a later funding operation for that
 * treasury successfully submits a transfer — direct evidence demand can be
 * served again. Never deletes the row (AGENTS.md §9). No recovery email
 * (none exists for this alert type; P1-US5 requires only the critical refusal
 * signal).
 */
export async function resolveTreasuryReserveAlert(
  dependencies: Pick<NotifyTreasuryReserveAlertDependencies, 'alerts' | 'auditEvents' | 'clock'>,
  input: ResolveTreasuryReserveAlertInput,
): Promise<ResolveTreasuryReserveAlertResult> {
  const existing = await dependencies.alerts.findOpenByEntity(
    TREASURY_ALERT_ENTITY_TYPE,
    input.treasuryId,
    TREASURY_RESERVE_ALERT_TYPE,
  );
  if (existing === undefined) {
    return { kind: 'none-open' };
  }

  const now = dependencies.clock.now();
  await dependencies.alerts.resolve({
    id: existing.id,
    resolvedAt: now,
    lastEvaluatedAt: now,
  });

  await dependencies.auditEvents.record({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: 'treasury.alert.resolved',
    entityType: TREASURY_ALERT_ENTITY_TYPE,
    entityId: input.treasuryId,
    requestId: input.operationId,
    sourceIp: undefined,
    metadata: {
      alertType: TREASURY_RESERVE_ALERT_TYPE,
      alertId: existing.id,
      transition: 'resolve',
      reason: 'funding-submitted',
    },
  });

  return { kind: 'resolved', alertId: existing.id };
}

function refusalMetadata(input: NotifyTreasuryReserveRefusalInput): Readonly<Record<string, unknown>> {
  return {
    requestedAmountWei: input.requestedAmountWei.toString(),
    treasuryBalanceWei: input.treasuryBalanceWei.toString(),
    minimumReserveWei: input.treasury.thresholds.minimumReserveWei.toString(),
    managedWalletId: input.managedWalletId,
    managedWalletAddressDisplay: input.managedWalletAddressDisplay,
  };
}

async function sendReserveEmail(
  dependencies: NotifyTreasuryReserveAlertDependencies,
  input: NotifyTreasuryReserveRefusalInput,
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
        alertType: TREASURY_RESERVE_ALERT_TYPE,
        alertId: alert.id,
        errorCode: 'EMAIL_PROVIDER_UNAVAILABLE',
        reason:
          dependencies.emailSender === undefined ? 'email-sender-unavailable' : 'no-operator-recipients',
      },
    });
    return 'failed';
  }

  const rendered = renderFundingUnavailableReserveEmail({
    environment: input.environment,
    chainDisplayName: input.treasury.chain.displayName,
    treasuryAddressDisplay: input.treasury.addressDisplay,
    treasuryBalanceWei: input.treasuryBalanceWei,
    minimumReserveWei: input.treasury.thresholds.minimumReserveWei,
    managedWalletAddressDisplay: input.managedWalletAddressDisplay,
    requestedAmountWei: input.requestedAmountWei,
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
        alertType: TREASURY_RESERVE_ALERT_TYPE,
        alertId: alert.id,
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
      alertType: TREASURY_RESERVE_ALERT_TYPE,
      alertId: alert.id,
      requestedAmountWei: input.requestedAmountWei.toString(),
      treasuryBalanceWei: input.treasuryBalanceWei.toString(),
    },
  });

  return 'sent';
}
