import type { AlertSeverity } from '../../domain/alerts/treasury-alert.js';
import {
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

export interface TreasuryUnresolvedReminderEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly observedBalanceWei: bigint;
  readonly severity: AlertSeverity;
  readonly activeThresholdWei: bigint;
  readonly firstTriggeredAt: Date;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'This alert remains open. Review the treasury balance and replenish funds if you have not already done so.';

function severityLabel(severity: AlertSeverity): string {
  return severity === 'critical' ? 'critical' : 'warning';
}

function thresholdLabel(severity: AlertSeverity): string {
  return severity === 'critical' ? 'Critical threshold' : 'Warning threshold';
}

/**
 * Sent when an open treasury alert is still unresolved after the reminder interval (PRD P3-US2).
 */
export function renderTreasuryUnresolvedReminderEmail(
  context: TreasuryUnresolvedReminderEmailContext,
): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const activeThreshold = formatBalanceDisplay(context.activeThresholdWei);
  const severity = severityLabel(context.severity);
  const triggeredAtIso = context.firstTriggeredAt.toISOString();
  const subject = `[REMINDER] ChainBank treasury ${severity} alert still open (${context.chainDisplayName})`;

  const text = [
    `ChainBank treasury ${severity} alert remains unresolved.`,
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `${thresholdLabel(context.severity)}:  ${activeThreshold}`,
    `Alert opened at:      ${triggeredAtIso}`,
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury alert reminder',
    `The treasury ${severity} alert remains unresolved.`,
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow('Treasury', context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow(thresholdLabel(context.severity), activeThreshold),
      htmlRow('Alert opened at', triggeredAtIso),
      htmlRow('Recommended action', RECOMMENDED_ACTION),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
