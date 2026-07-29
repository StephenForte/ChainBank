import { describe, expect, it } from 'vitest';
import { renderTreasuryWarningEmail } from '../../../src/app/email/treasury-warning-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  chainDisplayName: 'Ethereum Sepolia',
  treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  observedBalanceWei: 1_500_000_000_000_000_000n,
  warningThresholdWei: 2_000_000_000_000_000_000n,
  dashboardBaseUrl: 'http://localhost:3000',
} as const;

describe('renderTreasuryWarningEmail', () => {
  it('renders required treasury fields with formatted ETH balances', () => {
    const message = renderTreasuryWarningEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[WARNING]');
    expect(message.subject).toContain('Ethereum Sepolia');
    expect(message.text).toContain('Ethereum Sepolia');
    expect(message.text).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.text).toContain('1.5 ETH');
    expect(message.text).toContain('2 ETH');
    expect(message.text).toContain('Recommended action');
    expect(message.text).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.html).toContain('1.5 ETH');
    expect(message.html).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.html).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderTreasuryWarningEmail({
      ...BASE_CONTEXT,
      environment: '<script>alert(1)</script>',
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
