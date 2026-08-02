import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../../src/app/email/email-template-helpers.js';

describe('escapeHtml', () => {
  it('escapes characters that can break out of HTML text or attributes', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('Ethereum Sepolia')).toBe('Ethereum Sepolia');
  });

  it('neutralizes script tags when embedded in HTML', () => {
    const escaped = escapeHtml('<script>alert(1)</script>');
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(`<td>${escaped}</td>`).not.toContain('<script>');
  });
});
