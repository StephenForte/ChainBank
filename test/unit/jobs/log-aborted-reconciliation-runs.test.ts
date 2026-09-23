import { describe, expect, it, vi } from 'vitest';
import type {
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationRunRepository,
} from '../../../src/app/ports.js';
import type { Container } from '../../../src/container.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { logAbortedReconciliationRuns } from '../../../src/jobs/wallet-reconciler.js';
import { createFixedClock } from '../../support/clock.js';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const GRACE_MINUTES = 60;
interface AbortedRunLog {
  readonly correlationId: string;
  readonly abortedCount: number;
  readonly markedAborted: boolean;
  readonly abortedRuns: readonly { readonly errorCode: string | undefined }[];
}

const KEPT_FINDING: ReconciliationFinding = {
  kind: 'wallet_assessment_failed',
  severity: 'warning',
  walletId: 'wallet-kept',
  reason: 'left unchanged',
};

function unfinishedRun(
  id: string,
  startedAt: Date,
  overrides: Partial<ReconciliationRun> = {},
): ReconciliationRun {
  return {
    id,
    runId: id,
    requestedBy: 'wallet-reconciler',
    startedAt,
    finishedAt: undefined,
    walletsAssessed: 4,
    walletsFunded: 1,
    walletsNoop: 2,
    walletsBlocked: 1,
    walletsFailed: 0,
    weiTransferred: 42n,
    submissionUnknownResolved: 0,
    submissionUnknownLeftPending: 1,
    unexplainedTransferCount: 3,
    outgoingScanStatus: 'complete',
    findings: [KEPT_FINDING],
    errorCode: undefined,
    errorSummary: undefined,
    ...overrides,
  };
}

function harness(rows: readonly ReconciliationRun[], graceMinutes = GRACE_MINUTES) {
  const store = new Map(rows.map((row) => [row.id, row]));
  const markAborted = vi.fn(
    (input: {
      readonly ids: readonly string[];
      readonly finishedAt: Date;
      readonly errorSummary: string;
    }) => {
      const marked: ReconciliationRun[] = [];
      for (const id of input.ids) {
        const existing = store.get(id);
        if (existing === undefined || existing.finishedAt !== undefined) {
          continue;
        }
        const next: ReconciliationRun = {
          ...existing,
          finishedAt: input.finishedAt,
          errorCode: 'RUN_ABORTED',
          errorSummary: input.errorSummary,
        };
        store.set(id, next);
        marked.push(next);
      }
      return Promise.resolve(marked);
    },
  );
  const repo = {
    listAborted(olderThan: Date) {
      const unfinished = [...store.values()].filter(
        (row) => row.finishedAt === undefined && row.startedAt.getTime() < olderThan.getTime(),
      );
      unfinished.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return Promise.resolve(unfinished);
    },
    markAborted,
  } as unknown as ReconciliationRunRepository;
  const warn = vi.fn<(fields: AbortedRunLog, message: string) => void>();
  const container = {
    config: { reconciliation: { abortedRunGraceMinutes: graceMinutes } },
    clock: createFixedClock(NOW),
    logger: { warn },
    repositories: { reconciliationRuns: repo },
  } as unknown as Container;
  return { store, markAborted, warn, container };
}

describe('logAbortedReconciliationRuns', () => {
  it('marks only rows older than the grace window and warns once with markedAborted true', async () => {
    const old = unfinishedRun('old', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
    const { store, markAborted, warn, container } = harness([old]);

    expect(await logAbortedReconciliationRuns(container, 'marker-1')).toBe(1);

    expect(markAborted).toHaveBeenCalledTimes(1);
    expect(markAborted.mock.calls[0]?.[0].ids).toEqual(['old']);
    const stored = store.get('old');
    expect(stored?.finishedAt?.toISOString()).toBe(NOW.toISOString());
    expect(stored?.errorCode).toBe('RUN_ABORTED');
    expect(stored?.errorSummary).toBe(
      'Process exited before finish; marked aborted at startup by run marker-1',
    );
    expect(stored?.startedAt).toBe(old.startedAt);
    expect(stored?.walletsAssessed).toBe(4);
    expect(stored?.walletsFunded).toBe(1);
    expect(stored?.weiTransferred).toBe(42n);
    expect(stored?.outgoingScanStatus).toBe('complete');
    expect(stored?.findings).toEqual([KEPT_FINDING]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('Prior reconciliation runs aborted before finish');
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      correlationId: 'marker-1',
      abortedCount: 1,
      markedAborted: true,
    });
    expect(warn.mock.calls[0]?.[0].abortedRuns[0]?.errorCode).toBe('RUN_ABORTED');
  });

  it('warns about a row inside the grace window and leaves it unmarked', async () => {
    const recent = unfinishedRun('recent', new Date(NOW.getTime() - 5 * 60 * 1000), {
      outgoingScanStatus: 'not-run',
      walletsAssessed: 9,
    });
    const boundary = unfinishedRun('boundary', new Date(NOW.getTime() - GRACE_MINUTES * 60 * 1000));
    const { store, markAborted, warn, container } = harness([recent, boundary]);

    expect(await logAbortedReconciliationRuns(container, 'marker-2')).toBe(2);

    expect(markAborted).not.toHaveBeenCalled();
    expect(store.get('recent')?.finishedAt).toBeUndefined();
    expect(store.get('recent')?.errorCode).toBeUndefined();
    expect(store.get('recent')?.walletsAssessed).toBe(9);
    expect(store.get('boundary')?.finishedAt).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      abortedCount: 2,
      markedAborted: false,
    });
  });

  it('marks the old row and only warns about the in-window row when both exist', async () => {
    const old = unfinishedRun('old', new Date(NOW.getTime() - GRACE_MINUTES * 60 * 1000 - 1));
    const recent = unfinishedRun('recent', new Date(NOW.getTime() - 5 * 60 * 1000));
    const { store, markAborted, warn, container } = harness([old, recent]);

    expect(await logAbortedReconciliationRuns(container, 'marker-3')).toBe(2);

    expect(markAborted).toHaveBeenCalledTimes(1);
    expect(markAborted.mock.calls[0]?.[0].ids).toEqual(['old']);
    expect(store.get('old')?.errorCode).toBe('RUN_ABORTED');
    expect(store.get('recent')?.finishedAt).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => call[0].markedAborted)).toEqual([true, false]);
  });

  it('refuses to mark when reconciliation configuration is missing', async () => {
    const container = {
      config: { reconciliation: undefined },
      clock: createFixedClock(NOW),
      logger: { warn: vi.fn() },
      repositories: { reconciliationRuns: {} },
    } as unknown as Container;

    await expect(logAbortedReconciliationRuns(container, 'marker-4')).rejects.toBeInstanceOf(ChainBankError);
  });
});
