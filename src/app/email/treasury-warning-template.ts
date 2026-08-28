import {
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

export interface TreasuryWarningEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly treasuryKind?: 'external' | 'operational';
  readonly observedBalanceWei: bigint;
  readonly warningThresholdWei: bigint;
  readonly dashboardBaseUrl: string;
}

function recommendedAction(kind: 'external' | 'operational' | undefined): string {
  if (kind === 'operational') {
    return (
      'The Private treasury is low. ChainBank should refill it from the Public treasury. ' +
      'If Public is healthy, this is an operational failure — do not send faucet ETH here.'
    );
  }
  return (
    'Review the Public treasury balance and send testnet ETH to this address until it is ' +
    'at least the recovery threshold. Monitor managed wallet funding demand in the dashboard.'
  );
}

/**
 * Sent once when the treasury transitions from healthy to the warning band (PRD P3-US2).
 */
export function renderTreasuryWarningEmail(context: TreasuryWarningEmailContext): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const warningThreshold = formatBalanceDisplay(context.warningThresholdWei);
  const label = context.treasuryKind === 'operational' ? 'Private' : 'Public';
  const subject = `[WARNING] ChainBank ${label} treasury below warning threshold (${context.chainDisplayName})`;

  const text = [
    `ChainBank ${label} treasury balance is below the configured warning threshold.`,
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `${label} treasury:      ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Warning threshold:    ${warningThreshold}`,
    `Recommended action:   ${recommendedAction(context.treasuryKind)}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury warning',
    'The treasury balance is below the configured warning threshold.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow(`${label} treasury`, context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Warning threshold', warningThreshold),
      htmlRow('Recommended action', recommendedAction(context.treasuryKind)),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
