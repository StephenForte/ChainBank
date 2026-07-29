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
  readonly observedBalanceWei: bigint;
  readonly warningThresholdWei: bigint;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'Review the treasury balance and replenish funds to at least the recovery threshold. ' +
  'Monitor managed wallet funding demand in the dashboard.';

/**
 * Sent once when the treasury transitions from healthy to the warning band (PRD P3-US2).
 */
export function renderTreasuryWarningEmail(context: TreasuryWarningEmailContext): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const warningThreshold = formatBalanceDisplay(context.warningThresholdWei);
  const subject = `[WARNING] ChainBank treasury below warning threshold (${context.chainDisplayName})`;

  const text = [
    'ChainBank treasury balance is below the configured warning threshold.',
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Warning threshold:    ${warningThreshold}`,
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury warning',
    'The treasury balance is below the configured warning threshold.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow('Treasury', context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Warning threshold', warningThreshold),
      htmlRow('Recommended action', RECOMMENDED_ACTION),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
