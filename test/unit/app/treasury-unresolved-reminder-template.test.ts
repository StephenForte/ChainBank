import { describe, expect, it } from 'vitest';
import { renderTreasuryUnresolvedReminderEmail } from '../../../src/app/email/treasury-unresolved-reminder-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  chainDisplayName: 'Ethereum Sepolia',
  treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  observedBalanceWei: 1_500_000_000_000_000_000n,
  severity: 'warning' as const,
  activeThresholdWei: 2_000_000_000_000_000_000n,
  firstTriggeredAt: new Date('2026-07-26T12:00:00.000Z'),
  dashboardBaseUrl: 'http://localhost:3000',
};

describe('renderTreasuryUnresolvedReminderEmail', () => {
  it('renders required treasury fields with formatted ETH balances', () => {
    const message = renderTreasuryUnresolvedReminderEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[REMINDER]');
    expect(message.subject).toContain('Ethereum Sepolia');
    expect(message.text).toContain('Ethereum Sepolia');
    expect(message.text).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.text).toContain('1.5 ETH');
    expect(message.text).toContain('2 ETH');
    expect(message.text).toContain('Recommended action');
    expect(message.text).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).toContain('2026-07-26T12:00:00.000Z');
    expect(message.html).toContain('1.5 ETH');
    expect(message.html).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.html).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderTreasuryUnresolvedReminderEmail({
      ...BASE_CONTEXT,
      treasuryAddressDisplay: '0x<script>alert(1)</script>',
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
