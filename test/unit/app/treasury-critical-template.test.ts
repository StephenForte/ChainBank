import { describe, expect, it } from 'vitest';
import { renderTreasuryCriticalEmail } from '../../../src/app/email/treasury-critical-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  chainDisplayName: 'Ethereum Sepolia',
  treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  observedBalanceWei: 500_000_000_000_000_000n,
  criticalThresholdWei: 1_000_000_000_000_000_000n,
  dashboardBaseUrl: 'http://localhost:3000',
} as const;

describe('renderTreasuryCriticalEmail', () => {
  it('renders required treasury fields with formatted ETH balances', () => {
    const message = renderTreasuryCriticalEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[CRITICAL]');
    expect(message.subject).toContain('Ethereum Sepolia');
    expect(message.text).toContain('Ethereum Sepolia');
    expect(message.text).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.text).toContain('0.5 ETH');
    expect(message.text).toContain('1 ETH');
    expect(message.text).toContain('Recommended action');
    expect(message.text).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.html).toContain('0.5 ETH');
    expect(message.html).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.html).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderTreasuryCriticalEmail({
      ...BASE_CONTEXT,
      chainDisplayName: '<img src=x onerror=alert(1)>',
    });

    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
