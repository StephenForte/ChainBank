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
  readonly treasuryKind?: 'external' | 'operational';
  readonly observedBalanceWei: bigint;
  readonly criticalThresholdWei: bigint;
  readonly dashboardBaseUrl: string;
}

function recommendedAction(kind: 'external' | 'operational' | undefined): string {
  if (kind === 'operational') {
    return (
      'The Private treasury is critically low. ChainBank should refill it from the Public treasury. ' +
      'If Public is healthy, this is an operational failure — do not send faucet ETH here.'
    );
  }
  return (
    'Send testnet ETH to the Public treasury immediately. Managed wallet funding may fail until ' +
    'spendable balance is restored above the configured reserve.'
  );
}

/**
 * Sent once when the treasury enters the critical band (PRD P3-US2).
 */
export function renderTreasuryCriticalEmail(context: TreasuryCriticalEmailContext): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const criticalThreshold = formatBalanceDisplay(context.criticalThresholdWei);
  const label = context.treasuryKind === 'operational' ? 'Private' : 'Public';
  const subject = `[CRITICAL] ChainBank ${label} treasury critically low (${context.chainDisplayName})`;

  const text = [
    `ChainBank ${label} treasury balance is at or below the configured critical threshold.`,
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `${label} treasury:      ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Critical threshold:   ${criticalThreshold}`,
    `Recommended action:   ${recommendedAction(context.treasuryKind)}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury critical',
    'The treasury balance is at or below the configured critical threshold.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow(`${label} treasury`, context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Critical threshold', criticalThreshold),
      htmlRow('Recommended action', recommendedAction(context.treasuryKind)),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
