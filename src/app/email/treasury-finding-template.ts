import {
  escapeHtml,
  formatBalanceDisplay,
  htmlEmailShell,
  htmlRow,
  type RenderedEmailTemplate,
} from './email-template-helpers.js';

/**
 * Forensic context for a critical reconciliation finding email (C18 / TX.15).
 * Amount fields are decimal wei strings — never raw bigint (TX.11 / Pino).
 */
export interface TreasuryFindingEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly treasuryId: string;
  readonly findingKind: string;
  readonly transactionHash: string | undefined;
  readonly toAddress: string | undefined;
  readonly valueWei: string | undefined;
  readonly nonce: number | undefined;
  readonly blockNumber: string | undefined;
  readonly errorCode: string | undefined;
  readonly reason: string | undefined;
  readonly explorerTxUrl: string | undefined;
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'Treat this as a possible treasury-key compromise until a human confirms otherwise. ' +
  'Verify the transaction on the explorer, confirm whether an authorized operator initiated it, ' +
  'and rotate credentials if the transfer is unexplained.';

/**
 * Sent when reconciliation records a critical finding (e.g. unexplained outgoing
 * treasury transfer). Carries the forensic payload so the recipient can answer
 * "which transaction?" without a database query.
 */
export function renderTreasuryFindingEmail(context: TreasuryFindingEmailContext): RenderedEmailTemplate {
  const valueDisplay =
    context.valueWei === undefined ? undefined : formatBalanceDisplay(BigInt(context.valueWei));
  const subject = `[CRITICAL] ChainBank treasury finding — ${context.findingKind} (${context.chainDisplayName})`;

  const textLines = [
    'ChainBank reconciliation recorded a critical treasury finding that requires operator attention.',
    '',
    `Environment:          ${context.environment}`,
    `Chain:                ${context.chainDisplayName}`,
    `Treasury:             ${context.treasuryAddressDisplay}`,
    `Treasury id:          ${context.treasuryId}`,
    `Finding kind:         ${context.findingKind}`,
  ];

  if (context.transactionHash !== undefined) {
    textLines.push(`Transaction hash:     ${context.transactionHash}`);
  }
  if (context.toAddress !== undefined) {
    textLines.push(`Destination:          ${context.toAddress}`);
  }
  if (valueDisplay !== undefined) {
    textLines.push(`Value:                ${valueDisplay}`);
  }
  if (context.valueWei !== undefined) {
    textLines.push(`Value (wei):          ${context.valueWei}`);
  }
  if (context.nonce !== undefined) {
    textLines.push(`Nonce:                ${String(context.nonce)}`);
  }
  if (context.blockNumber !== undefined) {
    textLines.push(`Block:                ${context.blockNumber}`);
  }
  if (context.errorCode !== undefined) {
    textLines.push(`Error code:           ${context.errorCode}`);
  }
  if (context.reason !== undefined) {
    textLines.push(`Reason:               ${context.reason}`);
  }
  if (context.explorerTxUrl !== undefined) {
    textLines.push(`Explorer:             ${context.explorerTxUrl}`);
  }

  textLines.push(
    `Recommended action:   ${RECOMMENDED_ACTION}`,
    `Dashboard:            ${context.dashboardBaseUrl}`,
  );

  const rows = [
    htmlRow('Environment', context.environment),
    htmlRow('Chain', context.chainDisplayName),
    htmlRow('Treasury', context.treasuryAddressDisplay),
    htmlRow('Treasury id', context.treasuryId),
    htmlRow('Finding kind', context.findingKind),
  ];

  if (context.transactionHash !== undefined) {
    rows.push(htmlRow('Transaction hash', context.transactionHash));
  }
  if (context.toAddress !== undefined) {
    rows.push(htmlRow('Destination', context.toAddress));
  }
  if (valueDisplay !== undefined) {
    rows.push(htmlRow('Value', valueDisplay));
  }
  if (context.valueWei !== undefined) {
    rows.push(htmlRow('Value (wei)', context.valueWei));
  }
  if (context.nonce !== undefined) {
    rows.push(htmlRow('Nonce', String(context.nonce)));
  }
  if (context.blockNumber !== undefined) {
    rows.push(htmlRow('Block', context.blockNumber));
  }
  if (context.errorCode !== undefined) {
    rows.push(htmlRow('Error code', context.errorCode));
  }
  if (context.reason !== undefined) {
    rows.push(htmlRow('Reason', context.reason));
  }
  if (context.explorerTxUrl !== undefined) {
    rows.push(
      `<tr><td style="padding:4px 16px 4px 0;color:#666;">${escapeHtml('Explorer')}</td>` +
        `<td style="padding:4px 0;font-family:ui-monospace,monospace;">` +
        `<a href="${escapeHtml(context.explorerTxUrl)}">${escapeHtml(context.explorerTxUrl)}</a>` +
        `</td></tr>`,
    );
  }
  rows.push(htmlRow('Recommended action', RECOMMENDED_ACTION));

  const html = htmlEmailShell(
    'Critical treasury finding',
    'ChainBank reconciliation recorded a critical treasury finding that requires operator attention.',
    rows.join(''),
    context.dashboardBaseUrl,
  );

  return { subject, text: textLines.join('\n'), html };
}
