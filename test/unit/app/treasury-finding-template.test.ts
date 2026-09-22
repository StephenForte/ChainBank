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

  it('keeps the unexplained-transfer advice verbatim', () => {
    const message = renderTreasuryFindingEmail(BASE_CONTEXT);
    const action =
      'Treat this as a possible treasury-key compromise until a human confirms otherwise. ' +
      'Verify the transaction on the explorer, confirm whether an authorized operator initiated it, ' +
      'and rotate credentials if the transfer is unexplained.';

    expect(message.text).toContain(action);
    expect(message.html).toContain(action);
    expect(message.subject).toBe(
      '[CRITICAL] ChainBank treasury finding — unexplained_outgoing_transfer (Ethereum Sepolia)',
    );
  });

  it('tells the operator an incomplete scan found no transfer and to check the RPC endpoint', () => {
    const message = renderTreasuryFindingEmail({
      ...BASE_CONTEXT,
      findingKind: 'outgoing_scan_incomplete',
      transactionHash: undefined,
      toAddress: undefined,
      valueWei: undefined,
      nonce: undefined,
      blockNumber: undefined,
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'Treasury outgoing transaction scan could not be completed.',
      explorerTxUrl: undefined,
    });

    expect(message.subject).toBe(
      '[CRITICAL] ChainBank treasury finding — outgoing_scan_incomplete (Ethereum Sepolia)',
    );
    expect(message.text).toContain('Error code:           RPC_UNAVAILABLE');
    expect(message.text).toContain('Treasury outgoing transaction scan could not be completed.');
    expect(message.text).toContain('were not verified');
    expect(message.text).toContain('No outgoing transfer was detected, and none is implied.');
    expect(message.text).toContain('RPC endpoint');
    expect(message.text).toContain('next scheduled run');
    expect(message.html).toContain('were not verified');
    expect(message.html).toContain('No outgoing transfer was detected, and none is implied.');
    expect(message.html).toContain('RPC endpoint');
    expect(message.html).toContain('next scheduled run');
    expect(message.text).not.toMatch(/compromise/i);
    expect(message.text).not.toMatch(/rotate/i);
    expect(message.html).not.toMatch(/compromise/i);
    expect(message.html).not.toMatch(/rotate/i);
  });

  it('escapes HTML in operator-facing fields for both finding kinds', () => {
    const kinds = ['unexplained_outgoing_transfer', 'outgoing_scan_incomplete'] as const;
    for (const findingKind of kinds) {
      const message = renderTreasuryFindingEmail({
        ...BASE_CONTEXT,
        findingKind,
        toAddress: '<script>alert(1)</script>',
      });

      expect(message.html).not.toContain('<script>alert(1)</script>');
      expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});
