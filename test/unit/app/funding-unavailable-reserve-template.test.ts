import { describe, expect, it } from 'vitest';
import { renderFundingUnavailableReserveEmail } from '../../../src/app/email/funding-unavailable-reserve-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  chainDisplayName: 'Ethereum Sepolia',
  treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  treasuryBalanceWei: 1_100_000_000_000_000_000n,
  minimumReserveWei: 1_000_000_000_000_000_000n,
  managedWalletAddressDisplay: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  requestedAmountWei: 200_000_000_000_000_000n,
  dashboardBaseUrl: 'http://localhost:3000',
} as const;

describe('renderFundingUnavailableReserveEmail', () => {
  it('renders required treasury fields with formatted ETH balances', () => {
    const message = renderFundingUnavailableReserveEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[RESERVE]');
    expect(message.subject).toContain('Ethereum Sepolia');
    expect(message.text).toContain('Ethereum Sepolia');
    expect(message.text).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.text).toContain('1.1 ETH');
    expect(message.text).toContain('1 ETH');
    expect(message.text).toContain('0.2 ETH');
    expect(message.text).toContain(BASE_CONTEXT.managedWalletAddressDisplay);
    expect(message.text).toContain('Recommended action');
    expect(message.text).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.html).toContain('1.1 ETH');
    expect(message.html).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.html).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderFundingUnavailableReserveEmail({
      ...BASE_CONTEXT,
      managedWalletAddressDisplay: '0x<img src=x onerror=alert(1)>',
    });

    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
