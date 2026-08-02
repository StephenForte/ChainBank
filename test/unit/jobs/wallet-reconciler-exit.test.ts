import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ReconcileWalletsResult } from '../../../src/app/reconciliation/reconcile-wallets.js';
import {
  buildReconcilerCompletionLogFields,
  classifyReconcilerExit,
  logRunOutcome,
  reconcilerExitCode,
} from '../../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../../src/observability/logger.js';

function collectLogs(): { stream: Writable; lines: () => unknown[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}

function stubReconcileResult(weiTransferred: bigint): ReconcileWalletsResult {
  return {
    run: {
      id: 'run-row-1',
      runId: 'run-1',
      requestedBy: 'wallet-reconciler',
      startedAt: new Date('2026-08-02T00:00:00.000Z'),
      finishedAt: new Date('2026-08-02T00:00:01.000Z'),
      walletsAssessed: 1,
      walletsFunded: weiTransferred > 0n ? 1 : 0,
      walletsNoop: weiTransferred > 0n ? 0 : 1,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred,
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: 'complete',
      findings: [],
      errorCode: undefined,
      errorSummary: undefined,
    },
    counters: {
      assessed: 1,
      funded: weiTransferred > 0n ? 1 : 0,
      noop: weiTransferred > 0n ? 0 : 1,
      blocked: 0,
      failed: 0,
      weiTransferred,
    },
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 0,
    unexplainedTransferCount: 0,
    outgoingScanStatus: 'complete',
    findings: [],
  };
}

describe('wallet reconciler exit semantics', () => {
  it('treats a clean run as success (exit 0)', () => {
    expect(classifyReconcilerExit(undefined)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
  });

  it('treats FUNDING_DISABLED / kill switch as policy (exit 0)', () => {
    expect(classifyReconcilerExit('FUNDING_DISABLED')).toBe('policy-disabled');
    expect(reconcilerExitCode('policy-disabled')).toBe(0);
  });

  it('treats run-level malfunctions as non-zero', () => {
    for (const code of [
      'DATABASE_UNAVAILABLE',
      'RPC_UNAVAILABLE',
      'SIGNER_UNAVAILABLE',
      'INTERNAL_ERROR',
      'INVALID_CONFIGURATION',
    ]) {
      expect(classifyReconcilerExit(code)).toBe('malfunction');
      expect(reconcilerExitCode(classifyReconcilerExit(code))).toBe(1);
    }
  });
});

describe('wallet reconciler completion log weiTransferred', () => {
  it('emits weiTransferred as a decimal string, including zero', async () => {
    const zeroFields = buildReconcilerCompletionLogFields('corr-zero', 'success', stubReconcileResult(0n));
    expect(zeroFields.weiTransferred).toBe('0');
    expect(typeof zeroFields.weiTransferred).toBe('string');
    expect(() => JSON.stringify(zeroFields)).not.toThrow();

    const fundedWei = 254982149095701880n;
    const fundedFields = buildReconcilerCompletionLogFields(
      'corr-funded',
      'success',
      stubReconcileResult(fundedWei),
    );
    expect(fundedFields.weiTransferred).toBe(fundedWei.toString());
    expect(typeof fundedFields.weiTransferred).toBe('string');
    expect(() => JSON.stringify(fundedFields)).not.toThrow();

    // Regression anchor: a raw bigint in the log object would crash Pino /
    // JSON.stringify at the completion line of an otherwise successful run.
    expect(() => JSON.stringify({ weiTransferred: 0n })).toThrow(TypeError);

    const sink = collectLogs();
    const logger = createLogger({
      level: 'info',
      serviceRole: 'cron-reconciler',
      environment: 'test',
      destination: sink.stream,
    });
    logRunOutcome(logger, 'corr-log', 'success', stubReconcileResult(0n));
    await new Promise((resolve) => setImmediate(resolve));

    const [entry] = sink.lines() as Array<Record<string, unknown>>;
    expect(entry).toBeDefined();
    expect(entry?.msg).toBe('Wallet reconciler run completed');
    expect(entry?.weiTransferred).toBe('0');
    expect(typeof entry?.weiTransferred).toBe('string');
  });
});
