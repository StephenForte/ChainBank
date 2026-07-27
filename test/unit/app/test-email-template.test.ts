import { describe, expect, it } from 'vitest';
import { renderTestEmail } from '../../../src/app/email/test-email-template.js';

describe('renderTestEmail', () => {
  it('renders a test message without embedding secrets', () => {
    const message = renderTestEmail({
      environment: 'local',
      chainDisplayName: 'Ethereum Sepolia',
      treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      dashboardUrl: 'http://localhost:3000',
      sentAt: new Date('2026-07-26T12:00:00.000Z'),
      recipients: ['operator@example.com'],
    });

    expect(message.subject).toContain('local');
    expect(message.to).toEqual(['operator@example.com']);
    expect(message.text).toContain('Ethereum Sepolia');
    expect(message.html).toContain('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderTestEmail({
      environment: '<script>alert(1)</script>',
      chainDisplayName: 'Ethereum Sepolia',
      treasuryAddressDisplay: '0xabc',
      dashboardUrl: 'http://localhost:3000',
      sentAt: new Date('2026-07-26T12:00:00.000Z'),
      recipients: ['operator@example.com'],
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
