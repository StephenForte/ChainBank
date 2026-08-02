import type { EmailMessage } from '../ports.js';
import { escapeHtml } from './email-template-helpers.js';

export interface TestEmailContext {
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly dashboardUrl: string;
  readonly sentAt: Date;
  readonly recipients: readonly string[];
}

/**
 * Confirms the delivery path end to end. It deliberately carries only
 * information the operator already has, so a misdirected test message cannot
 * disclose anything sensitive.
 */
export function renderTestEmail(context: TestEmailContext): EmailMessage {
  const sentAtIso = context.sentAt.toISOString();
  const subject = `ChainBank test message (${context.environment})`;

  const text = [
    'This is a ChainBank test message.',
    '',
    'If you received it, operator alerts will reach this address.',
    '',
    `Environment:  ${context.environment}`,
    `Chain:        ${context.chainDisplayName}`,
    `Treasury:     ${context.treasuryAddressDisplay}`,
    `Sent at:      ${sentAtIso}`,
    `Dashboard:    ${context.dashboardUrl}`,
    '',
    'No action is required.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;">',
    '<h2 style="margin:0 0 12px;">ChainBank test message</h2>',
    '<p style="margin:0 0 16px;">If you received this, operator alerts will reach this address.</p>',
    '<table style="border-collapse:collapse;font-size:14px;">',
    row('Environment', context.environment),
    row('Chain', context.chainDisplayName),
    row('Treasury', context.treasuryAddressDisplay),
    row('Sent at', sentAtIso),
    '</table>',
    `<p style="margin:16px 0 0;"><a href="${escapeHtml(context.dashboardUrl)}">Open the ChainBank dashboard</a></p>`,
    '<p style="margin:16px 0 0;color:#666;font-size:13px;">No action is required.</p>',
    '</body></html>',
  ].join('');

  return { to: context.recipients, subject, text, html };
}

function row(label: string, value: string): string {
  return (
    `<tr><td style="padding:4px 16px 4px 0;color:#666;">${escapeHtml(label)}</td>` +
    `<td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(value)}</td></tr>`
  );
}
