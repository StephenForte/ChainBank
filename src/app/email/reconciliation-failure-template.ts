import { escapeHtml, type RenderedEmailTemplate } from './email-template-helpers.js';

export interface ReconciliationAffectedWallet {
  readonly projectSlug: string;
  readonly environmentSlug: string;
  readonly walletAddressDisplay: string;
}

export interface ReconciliationFailureEmailContext {
  readonly environment: string;
  readonly consecutiveFailureCount: number;
  readonly affectedWallets: readonly ReconciliationAffectedWallet[];
  readonly errorCategories: readonly string[];
  readonly dashboardBaseUrl: string;
}

const RECOMMENDED_ACTION =
  'Investigate the listed wallets and error categories in the dashboard and logs. ' +
  'Resolve underlying failures before the next reconciliation run.';

function formatWalletLine(wallet: ReconciliationAffectedWallet): string {
  return `${wallet.projectSlug}/${wallet.environmentSlug}: ${wallet.walletAddressDisplay}`;
}

function formatWalletList(wallets: readonly ReconciliationAffectedWallet[]): string {
  if (wallets.length === 0) {
    return '(none listed)';
  }
  return wallets.map(formatWalletLine).join('\n');
}

function formatCategoryList(categories: readonly string[]): string {
  if (categories.length === 0) {
    return '(none listed)';
  }
  return categories.join(', ');
}

/**
 * Sent after repeated reconciliation failures exceed the configured threshold (PRD P4-US3).
 */
export function renderReconciliationFailureEmail(
  context: ReconciliationFailureEmailContext,
): RenderedEmailTemplate {
  const walletLines = formatWalletList(context.affectedWallets);
  const categoryList = formatCategoryList(context.errorCategories);
  const subject = `[RECONCILE] ChainBank reconciliation failures (${String(context.consecutiveFailureCount)} consecutive runs)`;

  const text = [
    'ChainBank reconciliation has failed repeatedly and requires operator attention.',
    '',
    `Environment:              ${context.environment}`,
    `Consecutive failed runs:  ${String(context.consecutiveFailureCount)}`,
    'Affected wallets:',
    walletLines,
    `Error categories:         ${categoryList}`,
    `Recommended action:       ${RECOMMENDED_ACTION}`,
    `Dashboard:                ${context.dashboardBaseUrl}`,
  ].join('\n');

  const walletHtml =
    context.affectedWallets.length === 0
      ? '<li style="font-family:ui-monospace,monospace;">(none listed)</li>'
      : context.affectedWallets
          .map(
            (wallet) =>
              `<li style="font-family:ui-monospace,monospace;">${escapeHtml(formatWalletLine(wallet))}</li>`,
          )
          .join('');

  const categoryHtml =
    context.errorCategories.length === 0
      ? '<li style="font-family:ui-monospace,monospace;">(none listed)</li>'
      : context.errorCategories
          .map((category) => `<li style="font-family:ui-monospace,monospace;">${escapeHtml(category)}</li>`)
          .join('');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;">',
    '<h2 style="margin:0 0 12px;">Reconciliation failure alert</h2>',
    '<p style="margin:0 0 16px;">ChainBank reconciliation has failed repeatedly and requires operator attention.</p>',
    '<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">',
    `<tr><td style="padding:4px 16px 4px 0;color:#666;">${escapeHtml('Environment')}</td>`,
    `<td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(context.environment)}</td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0;color:#666;">${escapeHtml('Consecutive failed runs')}</td>`,
    `<td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(String(context.consecutiveFailureCount))}</td></tr>`,
    '</table>',
    `<p style="margin:0 0 8px;font-weight:600;">${escapeHtml('Affected wallets')}</p>`,
    `<ul style="margin:0 0 16px;padding-left:20px;">${walletHtml}</ul>`,
    `<p style="margin:0 0 8px;font-weight:600;">${escapeHtml('Error categories')}</p>`,
    `<ul style="margin:0 0 16px;padding-left:20px;">${categoryHtml}</ul>`,
    `<p style="margin:0 0 16px;">${escapeHtml(RECOMMENDED_ACTION)}</p>`,
    `<p style="margin:0;"><a href="${escapeHtml(context.dashboardBaseUrl)}">Open the ChainBank dashboard</a></p>`,
    '</body></html>',
  ].join('');

  return { subject, text, html };
}
