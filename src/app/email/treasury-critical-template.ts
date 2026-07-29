import {
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

export interface TreasuryCriticalEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly observedBalanceWei: bigint;
  readonly criticalThresholdWei: bigint;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'Replenish the treasury immediately. Managed wallet funding may fail until spendable ' +
  'balance is restored above the configured reserve.';

/**
 * Sent once when the treasury enters the critical band (PRD P3-US2).
 */
export function renderTreasuryCriticalEmail(context: TreasuryCriticalEmailContext): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const criticalThreshold = formatBalanceDisplay(context.criticalThresholdWei);
  const subject = `[CRITICAL] ChainBank treasury critically low (${context.chainDisplayName})`;

  const text = [
    'ChainBank treasury balance is at or below the configured critical threshold.',
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Critical threshold:   ${criticalThreshold}`,
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury critical',
    'The treasury balance is at or below the configured critical threshold.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow('Treasury', context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Critical threshold', criticalThreshold),
      htmlRow('Recommended action', RECOMMENDED_ACTION),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
