import type { AppInstance } from '../types.js';
import { listFundingTransactions } from '../../app/funding/list-funding-transactions.js';
import type { FundingTransactionListFilter } from '../../app/ports.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { FUNDING_OPERATION_STATUSES, FUNDING_TRANSACTION_STATUSES } from '../../domain/funding/statuses.js';
import type { FundingTransactionStatus } from '../../domain/funding/statuses.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeFundingTransaction } from '../serializers/funding-transaction.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const weiDecimalString = {
  type: 'string',
  pattern: '^[0-9]+$',
  minLength: 1,
  maxLength: 78,
} as const;

const fundingTransactionResponseProperties = {
  id: { type: 'string', format: 'uuid' },
  operation: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'operationType', 'status', 'requestedBy', 'startedAt', 'completedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      operationType: { type: 'string' },
      status: { type: 'string', enum: [...FUNDING_OPERATION_STATUSES] },
      requestedBy: { type: 'string' },
      startedAt: { type: 'string', format: 'date-time' },
      completedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    },
  },
  project: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'slug', 'name', 'enabled'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      name: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  },
  environment: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'slug', 'name', 'enabled'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      slug: { type: 'string' },
      name: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  },
  wallet: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'role', 'address'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      role: { type: 'string' },
      address: { type: 'string' },
    },
  },
  chain: {
    type: 'object',
    additionalProperties: false,
    required: ['slug', 'chainId', 'displayName', 'nativeSymbol'],
    properties: {
      slug: { type: 'string' },
      chainId: { type: 'integer' },
      displayName: { type: 'string' },
      nativeSymbol: { type: 'string' },
    },
  },
  amountWei: weiDecimalString,
  amountEther: { type: 'string' },
  status: { type: 'string', enum: [...FUNDING_TRANSACTION_STATUSES] },
  transactionHash: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 66, maxLength: 66 }] },
  explorerUrl: { anyOf: [{ type: 'null' }, { type: 'string', format: 'uri' }] },
  nonce: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] },
  errorCode: { anyOf: [{ type: 'null' }, { type: 'string' }] },
  createdAt: { type: 'string', format: 'date-time' },
  submittedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
  confirmedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
} as const;

const fundingTransactionResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'operation',
    'project',
    'environment',
    'wallet',
    'chain',
    'amountWei',
    'amountEther',
    'status',
    'transactionHash',
    'explorerUrl',
    'nonce',
    'errorCode',
    'createdAt',
    'submittedAt',
    'confirmedAt',
  ],
  properties: fundingTransactionResponseProperties,
} as const;

export function registerFundingTransactionRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/funding-transactions',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            environmentId: { type: 'string', format: 'uuid' },
            managedWalletId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: [...FUNDING_TRANSACTION_STATUSES] },
            createdFrom: { type: 'string', format: 'date-time' },
            createdTo: { type: 'string', format: 'date-time' },
            limit: { type: 'string', pattern: '^[0-9]+$' },
            offset: { type: 'string', pattern: '^[0-9]+$' },
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
                items: fundingTransactionResponseSchema,
              },
              pagination: {
                type: 'object',
                additionalProperties: false,
                required: ['limit', 'offset', 'total'],
                properties: {
                  limit: { type: 'integer' },
                  offset: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const query = request.query as {
        projectId?: string;
        environmentId?: string;
        managedWalletId?: string;
        status?: FundingTransactionStatus;
        createdFrom?: string;
        createdTo?: string;
        limit?: string;
        offset?: string;
      };

      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);

      const page = await listFundingTransactions(
        {
          fundingTransactions: container.repositories.fundingTransactions,
          credentialScopes: container.repositories.credentialScopes,
          environments: container.repositories.environments,
          managedWallets: container.repositories.managedWallets,
        },
        {
          role: actor.role,
          credentialId: actor.credentialId,
          filter: buildListFilter(query),
          limit,
          offset,
        },
      );

      return {
        data: page.items.map(serializeFundingTransaction),
        pagination: { limit, offset, total: page.total },
      };
    },
  );
}

function parsePageLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`,
      { publicMessage: `limit must be between 1 and ${String(MAX_PAGE_LIMIT)}.` },
    );
  }
  return value;
}

function parsePageOffset(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChainBankError('INVALID_REQUEST', 'offset must be a non-negative integer', {
      publicMessage: 'offset must be a non-negative integer.',
    });
  }
  return value;
}

function parseOptionalDate(raw: string | undefined, fieldName: string): Date | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ChainBankError('INVALID_REQUEST', `${fieldName} must be a valid ISO 8601 timestamp`, {
      publicMessage: `${fieldName} must be a valid ISO 8601 timestamp.`,
    });
  }
  return parsed;
}

function buildListFilter(query: {
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly managedWalletId?: string;
  readonly status?: FundingTransactionStatus;
  readonly createdFrom?: string;
  readonly createdTo?: string;
}): FundingTransactionListFilter {
  const createdFrom = parseOptionalDate(query.createdFrom, 'createdFrom');
  const createdTo = parseOptionalDate(query.createdTo, 'createdTo');

  return {
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    ...(query.environmentId === undefined ? {} : { environmentId: query.environmentId }),
    ...(query.managedWalletId === undefined ? {} : { managedWalletId: query.managedWalletId }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdTo === undefined ? {} : { createdTo }),
  };
}
