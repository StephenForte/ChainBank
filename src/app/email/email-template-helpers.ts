import { formatWeiAsEther } from '../../domain/wei.js';

export interface RenderedEmailTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Human-readable ETH for operator-facing copy. Display only — never use in calculations. */
export function formatBalanceDisplay(wei: bigint): string {
  return `${formatWeiAsEther(wei)} ETH`;
}

/** Escape text for safe interpolation into HTML element/attribute content. */
const HTML_ESCAPE_LOOKUP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  let escaped = '';
  for (const char of value) {
    escaped += HTML_ESCAPE_LOOKUP[char] ?? char;
  }
  return escaped;
}

export function htmlRow(label: string, value: string): string {
  return (
    `<tr><td style="padding:4px 16px 4px 0;color:#666;">${escapeHtml(label)}</td>` +
    `<td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(value)}</td></tr>`
  );
}

export function htmlEmailShell(title: string, intro: string, rows: string, dashboardBaseUrl: string): string {
  return [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;">',
    `<h2 style="margin:0 0 12px;">${escapeHtml(title)}</h2>`,
    `<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>`,
    '<table style="border-collapse:collapse;font-size:14px;">',
    rows,
    '</table>',
    `<p style="margin:16px 0 0;"><a href="${escapeHtml(dashboardBaseUrl)}">Open the ChainBank dashboard</a></p>`,
    '</body></html>',
  ].join('');
}
