import { describe, expect, it } from 'vitest';
import { renderTreasuryFindingEmail } from '../../../src/app/email/treasury-finding-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  chainDisplayName: 'Ethereum Sepolia',
  treasuryAddressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  treasuryId: '11111111-1111-1111-1111-111111111111',
  findingKind: 'unexplained_outgoing_transfer',
  transactionHash: `0x${'b1'.repeat(32)}`,
  toAddress: '0x5128123456789012345678901234567890ab652d',
  valueWei: '1000000000000000000',
  nonce: 3,
  blockNumber: '11425869',
  errorCode: undefined,
  reason: undefined,
  explorerTxUrl: `https://sepolia.etherscan.io/tx/0x${'b1'.repeat(32)}`,
  dashboardBaseUrl: 'http://localhost:3000',
} as const;

describe('renderTreasuryFindingEmail', () => {
  it('carries the forensic payload and explorer link', () => {
    const message = renderTreasuryFindingEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[CRITICAL]');
    expect(message.subject).toContain('unexplained_outgoing_transfer');
    expect(message.text).toContain(BASE_CONTEXT.transactionHash);
    expect(message.text).toContain(BASE_CONTEXT.toAddress);
    expect(message.text).toContain(BASE_CONTEXT.valueWei);
    expect(message.text).toContain('1 ETH');
    expect(message.text).toContain('Nonce:');
    expect(message.text).toContain('3');
    expect(message.text).toContain(BASE_CONTEXT.blockNumber);
    expect(message.text).toContain(BASE_CONTEXT.explorerTxUrl);
    expect(message.text).toContain(BASE_CONTEXT.treasuryAddressDisplay);
    expect(message.html).toContain(BASE_CONTEXT.transactionHash);
    expect(message.html).toContain(BASE_CONTEXT.explorerTxUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderTreasuryFindingEmail({
      ...BASE_CONTEXT,
      toAddress: '<script>alert(1)</script>',
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
