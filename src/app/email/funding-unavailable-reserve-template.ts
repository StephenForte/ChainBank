import {
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

export interface FundingUnavailableReserveEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly treasuryBalanceWei: bigint;
  readonly minimumReserveWei: bigint;
  readonly managedWalletAddressDisplay: string;
  readonly requestedAmountWei: bigint;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'Replenish the treasury so spendable balance (balance minus reserve) can cover legitimate ' +
  'funding requests. Review reserve policy and pending wallet demand in the dashboard.';

/**
 * Sent when a legitimate funding request is rejected because it would breach the treasury reserve.
 */
export function renderFundingUnavailableReserveEmail(
  context: FundingUnavailableReserveEmailContext,
): RenderedEmailTemplate {
  const observedBalance = formatBalanceDisplay(context.treasuryBalanceWei);
  const reserveThreshold = formatBalanceDisplay(context.minimumReserveWei);
  const requestedAmount = formatBalanceDisplay(context.requestedAmountWei);
  const subject = `[RESERVE] ChainBank funding blocked — treasury reserve (${context.chainDisplayName})`;

  const text = [
    'A legitimate funding request was rejected because it would breach the configured treasury reserve.',
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Observed balance:     ${observedBalance}`,
    `Reserve threshold:    ${reserveThreshold}`,
    `Managed wallet:       ${context.managedWalletAddressDisplay}`,
    `Requested amount:     ${requestedAmount}`,
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  ].join('\n');

  const html = htmlEmailShell(
    'Funding blocked by reserve',
    'A legitimate funding request was rejected because it would breach the configured treasury reserve.',
    [
      htmlRow('Environment', context.environment),
      htmlRow('Chain', context.chainDisplayName),
      htmlRow('Treasury', context.treasuryAddressDisplay),
      htmlRow('Observed balance', observedBalance),
      htmlRow('Reserve threshold', reserveThreshold),
      htmlRow('Managed wallet', context.managedWalletAddressDisplay),
      htmlRow('Requested amount', requestedAmount),
      htmlRow('Recommended action', RECOMMENDED_ACTION),
    ].join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text, html };
}
