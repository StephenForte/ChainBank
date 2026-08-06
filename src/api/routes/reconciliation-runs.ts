import type { AppInstance } from '../types.js';
import { listReconciliationRuns } from '../../app/reconciliation/list-reconciliation-runs.js';
import type { Container } from '../../container.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeReconciliationRun } from '../serializers/reconciliation-run.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../pagination.js';

const weiDecimalString = {
  type: 'string',
  pattern: '^[0-9]+$',
  minLength: 1,
  maxLength: 78,
} as const;

/**
 * Findings are unvalidated at rest across TX.9/TX.14/TX.15 writers. A strict
 * union with `additionalProperties: false` would 500 on old or unknown kinds —
 * the opposite of what an incident-read surface needs. Require nothing beyond
 * object shape; pass every property through (C19).
 *
 * Declaring NO properties is deliberate. `fast-json-stringify` coerces a
 * declared property to its declared type rather than rejecting it, so
 * `kind: { type: 'string' }` / `severity: { type: 'string' }` silently rewrote
 * a non-string value instead of passing it through: a planner probe measured
 * `severity: null` → `""` and `severity: { level: 'critical' }` →
 * `"[object Object]"`. Erasing the severity of a finding is precisely the
 * silent-evidence-loss this endpoint exists to prevent, so the schema declares
 * nothing and the passthrough is total.
 */
const reconciliationFindingResponseSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

const reconciliationRunResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'runId',
    'requestedBy',
    'startedAt',
    'finishedAt',
    'walletsAssessed',
    'walletsFunded',
    'walletsNoop',
    'walletsBlocked',
    'walletsFailed',
    'weiTransferred',
    'weiTransferredEther',
    'submissionUnknownResolved',
    'submissionUnknownLeftPending',
    'unexplainedTransferCount',
    'outgoingScanStatus',
    'findings',
    'errorCode',
    'errorSummary',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    runId: { type: 'string' },
    requestedBy: { type: 'string' },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    walletsAssessed: { type: 'integer' },
    walletsFunded: { type: 'integer' },
    walletsNoop: { type: 'integer' },
    walletsBlocked: { type: 'integer' },
    walletsFailed: { type: 'integer' },
    weiTransferred: weiDecimalString,
    weiTransferredEther: { type: 'string' },
    submissionUnknownResolved: { type: 'integer' },
    submissionUnknownLeftPending: { type: 'integer' },
    unexplainedTransferCount: { type: 'integer' },
    outgoingScanStatus: { type: 'string', enum: ['complete', 'incomplete', 'not-run'] },
    findings: {
      type: 'array',
      items: reconciliationFindingResponseSchema,
    },
    errorCode: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    errorSummary: { anyOf: [{ type: 'null' }, { type: 'string' }] },
  },
} as const;

export function registerReconciliationRunRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/reconciliation-runs',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...paginationQuerySchema,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: {
                type: 'array',
                items: reconciliationRunResponseSchema,
              },
              pagination: paginationResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const query = request.query as PaginationQuery;
      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);

      const page = await listReconciliationRuns(
        { reconciliationRuns: container.repositories.reconciliationRuns },
        {
          role: actor.role,
          limit,
          offset,
        },
      );

      return {
        data: page.items.map(serializeReconciliationRun),
        pagination: { limit, offset, total: page.total },
      };
    },
  );
}
