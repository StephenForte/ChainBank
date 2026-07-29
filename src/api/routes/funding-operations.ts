import type { AppInstance } from '../types.js';
import { getOperationStatus } from '../../app/funding/get-operation-status.js';
import type { Container } from '../../container.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeFundingOperation } from '../serializers/funding-operation.js';

const operationIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const weiDecimalString = {
  type: 'string',
  pattern: '^[0-9]+$',
  minLength: 1,
  maxLength: 78,
} as const;

const transactionResourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'status',
    'amountWei',
    'hash',
    'explorerUrl',
    'nonce',
    'errorCode',
    'createdAt',
    'submittedAt',
    'confirmedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string' },
    amountWei: weiDecimalString,
    hash: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    explorerUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nonce: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    errorCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string', format: 'date-time' },
    submittedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    confirmedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
} as const;

const fundingOperationResourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'operationType',
    'status',
    'reason',
    'projectId',
    'environmentId',
    'errorCode',
    'errorSummary',
    'startedAt',
    'completedAt',
    'transaction',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    operationType: { type: 'string' },
    status: { type: 'string' },
    reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    projectId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    environmentId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    errorCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    errorSummary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    startedAt: { type: 'string', format: 'date-time' },
    completedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    transaction: { anyOf: [transactionResourceSchema, { type: 'null' }] },
  },
} as const;

/**
 * Funding operation status lookup + confirmation resume (P2-US3 / T2.3).
 *
 * Read-plus-track only: may call trackTransaction for a `submitted` row, but
 * never dispatches, signs, or constructs a treasury signer.
 */
export function registerFundingOperationRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/funding-operations/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: operationIdParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: fundingOperationResourceSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const result = await getOperationStatus(
        {
          operations: container.repositories.fundingOperations,
          transactions: container.repositories.fundingTransactions,
          receiptTracker: container.transactionReceiptTracker,
          credentialScopes: container.repositories.credentialScopes,
          clock: container.clock,
          logger: container.logger,
          confirmations: container.config.funding.confirmations,
          confirmationTimeoutMs: container.config.funding.confirmationTimeoutMs,
          treasuryAddress: container.config.treasury.address,
        },
        {
          operationId: id,
          role: actor.role,
          credentialId: actor.credentialId,
          correlationId: request.id,
        },
      );

      return {
        data: serializeFundingOperation(result, container.config.chain.explorerBaseUrl),
      };
    },
  );
}
