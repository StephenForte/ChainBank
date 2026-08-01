import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import {
  renderReconciliationFailureEmail,
  type ReconciliationAffectedWallet,
} from '../email/reconciliation-failure-template.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailSender,
  ManagedWalletRepository,
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationRunRepository,
  StoredOpenAlert,
  Treasury,
} from '../ports.js';
import { TREASURY_ALERT_ENTITY_TYPE } from './evaluate-treasury-alerts.js';

/**
 * Alert type for repeated reconciliation-run failures (P4-US3 / C15). Distinct
 * from balance and reserve types so all three may be open on one treasury (C3a).
 */
export const RECONCILIATION_FAILURE_ALERT_TYPE = 'reconciliation_failure';

/** Policy refusals that must neither page nor resolve (C15). */
const POLICY_REFUSAL_ERROR_CODES: ReadonlySet<string> = new Set(['FUNDING_DISABLED']);

/** How many recent runs to inspect when deriving the consecutive failure streak. */
const RECENT_RUN_LOOKBACK = 64;

export type ReconciliationRunClass = 'failure' | 'success' | 'neutral';

export interface NotifyReconciliationFailureDependencies {
  readonly alerts: AlertRepository;
  readonly reconciliationRuns: ReconciliationRunRepository;
  readonly managedWallets: ManagedWalletRepository;
  /** When absent, the alert is still persisted with pendingEmail for later retry. */
  readonly emailSender: EmailSender | undefined;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface NotifyReconciliationFailureInput {
  readonly run: ReconciliationRun;
  readonly treasury: Treasury;
  readonly failureAlertThreshold: number;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
  readonly operationId: string;
  readonly actor: {
    readonly type: 'api_credential' | 'cron';
    readonly id: string;
  };
}

export type NotifyReconciliationFailureResult =
  | { readonly kind: 'opened'; readonly alertId: string; readonly email: 'sent' | 'failed' }
  | { readonly kind: 'deduped'; readonly alertId: string }
  | { readonly kind: 'retried'; readonly alertId: string; readonly email: 'sent' | 'failed' }
  | { readonly kind: 'resolved'; readonly alertId: string }
  | { readonly kind: 'none-open' }
  | {
      readonly kind: 'skipped';
      readonly reason: 'below-threshold' | 'policy-refusal' | 'unfinished-run' | 'non-positive-threshold';
    };

/**
 * Classifies a finished reconciliation run for consecutive-failure alerting (C15).
 *
 * - `failure`: `error_code` set and not a policy refusal.
 * - `success`: finished with no `error_code`.
 * - `neutral`: unfinished, or policy refusal (`FUNDING_DISABLED` / kill switch).
 *
 * `outgoing_scan_status: 'incomplete'` and `wallets_failed > 0` alone do **not**
 * classify as failure — those are in-run degradations on an otherwise completed
 * sweep; paging is reserved for run-level process failure.
 */
export function classifyReconciliationRun(
  run: Pick<ReconciliationRun, 'finishedAt' | 'errorCode'>,
): ReconciliationRunClass {
  if (run.finishedAt === undefined) {
    return 'neutral';
  }
  if (run.errorCode === undefined) {
    return 'success';
  }
  if (POLICY_REFUSAL_ERROR_CODES.has(run.errorCode)) {
    return 'neutral';
  }
  return 'failure';
}

/**
 * Counts consecutive failures from a newest-first recent list. Neutral runs are
 * skipped (transparent); a success ends the streak.
 */
export function countConsecutiveFailures(recentNewestFirst: readonly ReconciliationRun[]): number {
  let count = 0;
  for (const run of recentNewestFirst) {
    const classification = classifyReconciliationRun(run);
    if (classification === 'neutral') {
      continue;
    }
    if (classification === 'success') {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Evaluates reconciliation failure / recovery alerting after a completed run
 * (PRD P4-US3). One open `reconciliation_failure` alert per treasury: the first
 * evaluation that reaches the consecutive threshold persist-then-sends; later
 * failures update `last_evaluated_at` + metadata only. A later successful run
 * resolves without a recovery email (no template; C10 precedent).
 */
export async function maybeNotifyReconciliationFailure(
  dependencies: NotifyReconciliationFailureDependencies,
  input: NotifyReconciliationFailureInput,
): Promise<NotifyReconciliationFailureResult> {
  if (!Number.isInteger(input.failureAlertThreshold) || input.failureAlertThreshold < 1) {
    dependencies.logger.warn(
      {
        event: 'reconciliation.failure_alert.skipped',
        treasuryId: input.treasury.id,
        operationId: input.operationId,
        reason: 'non-positive-threshold',
        failureAlertThreshold: input.failureAlertThreshold,
      },
      'Skipping reconciliation failure alert: threshold is not a positive integer',
    );
    return { kind: 'skipped', reason: 'non-positive-threshold' };
  }

  const classification = classifyReconciliationRun(input.run);
  if (classification === 'neutral') {
    return {
      kind: 'skipped',
      reason: input.run.finishedAt === undefined ? 'unfinished-run' : 'policy-refusal',
    };
  }

  if (classification === 'success') {
    return resolveReconciliationFailureAlert(dependencies, input);
  }

  const recent = await dependencies.reconciliationRuns.listRecent(RECENT_RUN_LOOKBACK);
  const consecutiveFailureCount = countConsecutiveFailures(recent);

  if (consecutiveFailureCount < input.failureAlertThreshold) {
    return { kind: 'skipped', reason: 'below-threshold' };
  }

  const affectedWallets = await collectAffectedWallets(dependencies.managedWallets, input.run.findings);
  const errorCategories = collectErrorCategories(input.run);
  const metadata = {
    consecutiveFailureCount,
    affectedWallets,
    errorCategories,
    latestRunId: input.run.runId,
    latestErrorCode: input.run.errorCode,
  };

  const now = dependencies.clock.now();
  const existing = await dependencies.alerts.findOpenByEntity(
    TREASURY_ALERT_ENTITY_TYPE,
    input.treasury.id,
    RECONCILIATION_FAILURE_ALERT_TYPE,
  );

  if (existing === undefined) {
    const opened = await dependencies.alerts.insertOpen({
      alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_ALERT_ENTITY_TYPE,
      entityId: input.treasury.id,
      firstTriggeredAt: now,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });

    const email = await sendFailureEmail(dependencies, input, opened, {
      consecutiveFailureCount,
      affectedWallets,
      errorCategories,
    });
    return { kind: 'opened', alertId: opened.id, email };
  }

  if (existing.pendingEmail !== undefined) {
    const pending = await dependencies.alerts.markPendingEmail({
      id: existing.id,
      lastEvaluatedAt: now,
      pendingEmail: 'critical',
      metadata,
    });
    const email = await sendFailureEmail(dependencies, input, pending, {
      consecutiveFailureCount,
      affectedWallets,
      errorCategories,
    });
    return { kind: 'retried', alertId: pending.id, email };
  }

  await dependencies.alerts.touchLastEvaluated({
    id: existing.id,
    lastEvaluatedAt: now,
    metadata,
  });
  return { kind: 'deduped', alertId: existing.id };
}

async function resolveReconciliationFailureAlert(
  dependencies: Pick<NotifyReconciliationFailureDependencies, 'alerts' | 'auditEvents' | 'clock'>,
  input: NotifyReconciliationFailureInput,
): Promise<Extract<NotifyReconciliationFailureResult, { kind: 'resolved' | 'none-open' }>> {
  const existing = await dependencies.alerts.findOpenByEntity(
    TREASURY_ALERT_ENTITY_TYPE,
    input.treasury.id,
    RECONCILIATION_FAILURE_ALERT_TYPE,
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
    entityId: input.treasury.id,
    requestId: input.operationId,
    sourceIp: undefined,
    metadata: {
      alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
      alertId: existing.id,
      transition: 'resolve',
      reason: 'reconciliation-recovered',
      runId: input.run.runId,
    },
  });

  return { kind: 'resolved', alertId: existing.id };
}

async function collectAffectedWallets(
  managedWallets: ManagedWalletRepository,
  findings: readonly ReconciliationFinding[],
): Promise<readonly ReconciliationAffectedWallet[]> {
  const wallets: ReconciliationAffectedWallet[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (finding.kind !== 'wallet_assessment_failed') {
      continue;
    }
    if (seen.has(finding.walletId)) {
      continue;
    }
    seen.add(finding.walletId);
    const wallet = await managedWallets.findById(finding.walletId);
    if (wallet === undefined) {
      continue;
    }
    wallets.push({
      projectSlug: wallet.project.slug,
      environmentSlug: wallet.environment.slug,
      walletAddressDisplay: wallet.addressDisplay,
    });
  }

  return wallets;
}

function collectErrorCategories(run: ReconciliationRun): readonly string[] {
  const categories = new Set<string>();
  if (run.errorCode !== undefined) {
    categories.add(run.errorCode);
  }
  for (const finding of run.findings) {
    categories.add(finding.kind);
  }
  return [...categories].sort();
}

async function sendFailureEmail(
  dependencies: NotifyReconciliationFailureDependencies,
  input: NotifyReconciliationFailureInput,
  alert: StoredOpenAlert,
  content: {
    readonly consecutiveFailureCount: number;
    readonly affectedWallets: readonly ReconciliationAffectedWallet[];
    readonly errorCategories: readonly string[];
  },
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
        alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
        alertId: alert.id,
        errorCode: 'EMAIL_PROVIDER_UNAVAILABLE',
        reason:
          dependencies.emailSender === undefined ? 'email-sender-unavailable' : 'no-operator-recipients',
      },
    });
    return 'failed';
  }

  const rendered = renderReconciliationFailureEmail({
    environment: input.environment,
    consecutiveFailureCount: content.consecutiveFailureCount,
    affectedWallets: content.affectedWallets,
    errorCategories: content.errorCategories,
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
        alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
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
      alertType: RECONCILIATION_FAILURE_ALERT_TYPE,
      alertId: alert.id,
      consecutiveFailureCount: content.consecutiveFailureCount,
      errorCategories: content.errorCategories,
    },
  });

  return 'sent';
}
