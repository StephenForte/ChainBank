import { describe, expect, it } from 'vitest';
import { serializeReconciliationRun } from '../../../src/api/serializers/reconciliation-run.js';
import type { ReconciliationRun } from '../../../src/app/ports.js';

function baseRun(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: 'run-1',
    requestedBy: 'cred-1',
    startedAt: new Date('2026-08-05T18:00:00.000Z'),
    finishedAt: new Date('2026-08-05T18:00:20.000Z'),
    walletsAssessed: 4,
    walletsFunded: 0,
    walletsNoop: 4,
    walletsBlocked: 0,
    walletsFailed: 0,
    weiTransferred: 0n,
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: 1,
    outgoingScanStatus: 'complete',
    findings: [],
    errorCode: undefined,
    errorSummary: undefined,
    ...overrides,
  };
}

describe('serializeReconciliationRun', () => {
  it('converts weiTransferred bigint to a decimal string (TX.11 / C19)', () => {
    // Above 2^64 so a Number-based path would lose precision.
    const wei = 20_000_000_000_000_000_000n;
    const resource = serializeReconciliationRun(baseRun({ weiTransferred: wei }));
    expect(resource.weiTransferred).toBe('20000000000000000000');
    expect(typeof resource.weiTransferred).toBe('string');
    expect(resource.weiTransferredEther).toBe('20');
  });

  it('passes through an unrecognised finding kind without dropping it', () => {
    const unknownFinding = {
      kind: 'future_detector_signal',
      severity: 'critical',
      treasuryId: 'treasury-1',
      detail: 'preserved',
      nested: { a: 1 },
    };
    const resource = serializeReconciliationRun(
      baseRun({
        findings: [unknownFinding as never],
      }),
    );
    expect(resource.findings).toHaveLength(1);
    expect(resource.findings[0]).toEqual(unknownFinding);
  });

  it('preserves known critical and warning findings', () => {
    const resource = serializeReconciliationRun(
      baseRun({
        findings: [
          {
            kind: 'unexplained_outgoing_transfer',
            severity: 'critical',
            treasuryId: 'treasury-1',
            transactionHash: '0xabc',
            toAddress: '0x5128',
            valueWei: '1000000000000000000',
            nonce: 3,
            blockNumber: '11425869',
          },
          {
            kind: 'wallet_assessment_failed',
            severity: 'warning',
            walletId: 'wallet-1',
            reason: 'rpc timeout',
          },
        ],
      }),
    );
    expect(resource.findings).toHaveLength(2);
    expect(resource.findings[0]?.kind).toBe('unexplained_outgoing_transfer');
    expect(resource.findings[1]?.kind).toBe('wallet_assessment_failed');
  });

  it('serializes unfinished runs with finishedAt null', () => {
    const resource = serializeReconciliationRun(
      baseRun({
        finishedAt: undefined,
        outgoingScanStatus: 'not-run',
      }),
    );
    expect(resource.finishedAt).toBeNull();
    expect(resource.startedAt).toBe('2026-08-05T18:00:00.000Z');
  });

  it('wraps a non-object finding rather than dropping it', () => {
    const resource = serializeReconciliationRun(
      baseRun({
        findings: ['legacy-string-finding' as never],
      }),
    );
    expect(resource.findings).toEqual([
      {
        kind: 'unrecognised_finding_shape',
        severity: 'unknown',
        value: 'legacy-string-finding',
      },
    ]);
  });
});
