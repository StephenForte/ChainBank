import type { AppInstance } from '../types.js';
import { getOperationStatus } from '../../app/funding/get-operation-status.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import {
  serializeFundingOperation,
  type FundingOperationChainContext,
} from '../serializers/funding-operation.js';

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

const chainResourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'chainId', 'displayName', 'nativeSymbol'],
  properties: {
    slug: { type: 'string' },
    chainId: { type: 'integer' },
    displayName: { type: 'string' },
    nativeSymbol: { type: 'string' },
  },
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
    'treasuryAddress',
    'chain',
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
    treasuryAddress: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    chain: { anyOf: [chainResourceSchema, { type: 'null' }] },
  },
} as const;

/**
 * Receipt resume reads the sender only while a transaction is `submitted`.
 * An operation with no treasury row has nothing to track; this value is never
 * a configured treasury and is never taken from the default chain.
 */
const SENDER_WHEN_TREASURY_UNKNOWN = '0x0000000000000000000000000000000000000000';

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

      // The signing treasury is the transaction's treasury row. The default
      // chain's treasury is a different fact and must not be substituted.
      const recordedTransaction = await container.repositories.fundingTransactions.findByOperationId(id);
      const recordedTreasury =
        recordedTransaction === undefined
          ? undefined
          : await container.repositories.treasuries.findById(recordedTransaction.treasuryId);
      if (recordedTransaction?.status === 'submitted' && recordedTreasury === undefined) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          `Funding transaction treasury ${recordedTransaction.treasuryId} does not exist`,
          { publicMessage: 'The service is misconfigured.' },
        );
      }

      const result = await getOperationStatus(
        {
          operations: container.repositories.fundingOperations,
          transactions: container.repositories.fundingTransactions,
          chainAdapters: container.chainAdapters,
          treasuryChainId: async (treasuryId) => {
            const treasury =
              recordedTreasury?.id === treasuryId
                ? recordedTreasury
                : await container.repositories.treasuries.findById(treasuryId);
            if (treasury === undefined) {
              throw new ChainBankError(
                'INVALID_CONFIGURATION',
                `Funding transaction treasury ${treasuryId} does not exist`,
                { publicMessage: 'The service is misconfigured.' },
              );
            }
            return treasury.chain.chainId;
          },
          credentialScopes: container.repositories.credentialScopes,
          clock: container.clock,
          logger: container.logger,
          confirmations: container.config.funding.confirmations,
          confirmationTimeoutMs: container.config.funding.confirmationTimeoutMs,
          treasuryAddress: recordedTreasury?.addressDisplay ?? SENDER_WHEN_TREASURY_UNKNOWN,
        },
        {
          operationId: id,
          role: actor.role,
          credentialId: actor.credentialId,
          correlationId: request.id,
        },
      );

      const transactionChain: FundingOperationChainContext | undefined =
        recordedTreasury === undefined
          ? undefined
          : {
              explorerBaseUrl: recordedTreasury.chain.explorerBaseUrl,
              slug: recordedTreasury.chain.slug,
              chainId: recordedTreasury.chain.chainId,
              displayName: recordedTreasury.chain.displayName,
              nativeSymbol: recordedTreasury.chain.nativeSymbol,
              treasuryAddress: recordedTreasury.addressDisplay,
            };

      return {
        data: serializeFundingOperation(result, transactionChain),
      };
    },
  );
}
