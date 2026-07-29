import {
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

export interface TreasuryRecoveryEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly observedBalanceWei: bigint;
  readonly recoveryThresholdWei: bigint;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'The treasury balance is back above the recovery threshold. No further action is required for this alert.';

/**
 * Sent once when the treasury satisfies the recovery threshold after an open alert (PRD P3-US3).
 */
export function renderTreasuryRecoveryEmail(context: TreasuryRecoveryEmailContext): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.observedBalanceWei);
  const recoveryThreshold = formatBalanceDisplay(context.recoveryThresholdWei);
  const subject = `[RECOVERY] ChainBank treasury balance restored (${context.chainDisplayName})`;

  const text = [
    'ChainBank treasury balance has reached the configured recovery threshold.',
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Recovery threshold:   ${recoveryThreshold}`,
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Treasury recovery',
    'The treasury balance has reached the configured recovery threshold.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow('Treasury', context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Recovery threshold', recoveryThreshold),
      htmlRow('Recommended action', RECOMMENDED_ACTION),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
