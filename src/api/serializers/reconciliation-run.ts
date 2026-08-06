import type { ReconciliationRun } from '../../app/ports.js';
import { formatWeiAsEther } from '../../domain/wei.js';

/**
 * Wire shape for a reconciliation run (C19).
 *
 * `weiTransferred` is typed as `string` so a raw `bigint` fails typecheck before
 * it can reach Fastify's JSON serializer (TX.11 pattern).
 *
 * Findings are unvalidated at rest — pass them through as opaque records so an
 * unrecognised `kind` still appears rather than 500ing the read of the evidence.
 */
export interface ReconciliationRunResource {
  readonly id: string;
  readonly runId: string;
  readonly requestedBy: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly walletsAssessed: number;
  readonly walletsFunded: number;
  readonly walletsNoop: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
  readonly weiTransferred: string;
  readonly weiTransferredEther: string;
  readonly submissionUnknownResolved: number;
  readonly submissionUnknownLeftPending: number;
  readonly unexplainedTransferCount: number;
  readonly outgoingScanStatus: 'complete' | 'incomplete' | 'not-run';
  readonly findings: readonly Record<string, unknown>[];
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
}

export function serializeReconciliationRun(run: ReconciliationRun): ReconciliationRunResource {
  const weiTransferred: string = run.weiTransferred.toString();
  return {
    id: run.id,
    runId: run.runId,
    requestedBy: run.requestedBy,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    walletsAssessed: run.walletsAssessed,
    walletsFunded: run.walletsFunded,
    walletsNoop: run.walletsNoop,
    walletsBlocked: run.walletsBlocked,
    walletsFailed: run.walletsFailed,
    weiTransferred,
    weiTransferredEther: formatWeiAsEther(run.weiTransferred),
    submissionUnknownResolved: run.submissionUnknownResolved,
    submissionUnknownLeftPending: run.submissionUnknownLeftPending,
    unexplainedTransferCount: run.unexplainedTransferCount,
    outgoingScanStatus: run.outgoingScanStatus,
    findings: run.findings.map(findingToRecord),
    errorCode: run.errorCode ?? null,
    errorSummary: run.errorSummary ?? null,
  };
}

function findingToRecord(finding: unknown): Record<string, unknown> {
  if (finding !== null && typeof finding === 'object' && !Array.isArray(finding)) {
    return { ...(finding as Record<string, unknown>) };
  }
  // Preserve a non-object finding rather than dropping it — unknown shapes are
  // more interesting than silence (C19 fail-permissive presentation).
  return { kind: 'unrecognised_finding_shape', severity: 'unknown', value: finding };
}
