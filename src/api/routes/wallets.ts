import type { AppInstance } from '../types.js';
import { ensureWalletFunded } from '../../app/funding/ensure-wallet-funded.js';
import { listWallets } from '../../app/wallets/list-wallets.js';
import { readWalletBalance } from '../../app/wallets/read-wallet-balance.js';
import { registerWallet } from '../../app/wallets/register-wallet.js';
import { setWalletPolicy } from '../../app/wallets/set-wallet-policy.js';
import { updateWallet } from '../../app/wallets/update-wallet.js';
import type { Container } from '../../container.js';
import { formatWeiAsEther, parseWeiDecimalString } from '../../domain/wei.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeManagedWallet } from '../serializers/wallet.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
} from '../pagination.js';

const walletIdParams = {
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

const managedWalletResponseProperties = {
  id: { type: 'string', format: 'uuid' },
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
  role: { type: 'string' },
  address: { type: 'string' },
  explorerUrl: { type: 'string' },
  enabled: { type: 'boolean' },
  criticalAtStartup: { type: 'boolean' },
  reconciliationEnabled: { type: 'boolean' },
  policy: {
    anyOf: [
      { type: 'null' },
      {
        type: 'object',
        additionalProperties: false,
        required: ['minimumBalanceWei', 'targetBalanceWei', 'maximumTopUpWei', 'version', 'updatedAt'],
        properties: {
          minimumBalanceWei: weiDecimalString,
          targetBalanceWei: weiDecimalString,
          maximumTopUpWei: weiDecimalString,
          version: { type: 'integer', minimum: 1 },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    ],
  },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const managedWalletResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'project',
    'environment',
    'chain',
    'role',
    'address',
    'explorerUrl',
    'enabled',
    'criticalAtStartup',
    'reconciliationEnabled',
    'policy',
    'createdAt',
    'updatedAt',
  ],
  properties: managedWalletResponseProperties,
} as const;

const ensureFundedResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'operationId',
    'balanceBeforeWei',
    'minimumBalanceWei',
    'targetBalanceWei',
    'transferredWei',
    'transactionHash',
    'explorerUrl',
    'reasonCode',
  ],
  properties: {
    status: { type: 'string', enum: ['no-op', 'funded', 'pending', 'blocked', 'failed'] },
    operationId: { type: 'string', format: 'uuid' },
    balanceBeforeWei: weiDecimalString,
    minimumBalanceWei: weiDecimalString,
    targetBalanceWei: weiDecimalString,
    transferredWei: { anyOf: [{ type: 'null' }, weiDecimalString] },
    transactionHash: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 66, maxLength: 66 }] },
    explorerUrl: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    reasonCode: { anyOf: [{ type: 'null' }, { type: 'string' }] },
  },
} as const;

/** C17 — live wallet balance. Discriminated so unavailable never looks like wei 0. */
const walletBalanceResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['balance'],
  properties: {
    balance: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['outcome', 'wei', 'ether', 'blockNumber', 'observedAt'],
          properties: {
            outcome: { type: 'string', enum: ['observed'] },
            wei: weiDecimalString,
            ether: { type: 'string', minLength: 1 },
            blockNumber: { type: 'string', pattern: '^[0-9]+$' },
            observedAt: { type: 'string', format: 'date-time' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['outcome', 'errorCode', 'reason', 'observedAt'],
          properties: {
            outcome: { type: 'string', enum: ['unavailable'] },
            errorCode: { type: 'string', enum: ['RPC_UNAVAILABLE', 'CHAIN_ID_MISMATCH'] },
            reason: { type: 'string' },
            observedAt: { type: 'string', format: 'date-time' },
          },
        },
      ],
    },
  },
} as const;

export function registerWalletRoutes(app: AppInstance, container: Container): void {
  const walletDeps = {
    managedWallets: container.repositories.managedWallets,
    projects: container.repositories.projects,
    environments: container.repositories.environments,
    chains: container.repositories.chains,
    fundingPolicies: container.repositories.fundingPolicies,
    operatorMutations: container.operatorMutations,
  };

  app.post(
    '/v1/wallets',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'environmentId', 'chainId', 'role', 'address'],
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            environmentId: { type: 'string', format: 'uuid' },
            chainId: { type: 'integer', minimum: 1 },
            role: { type: 'string', minLength: 1, maxLength: 64 },
            address: { type: 'string', minLength: 42, maxLength: 42 },
            criticalAtStartup: { type: 'boolean' },
            reconciliationEnabled: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: managedWalletResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const body = request.body as {
        projectId: string;
        environmentId: string;
        chainId: number;
        role: string;
        address: string;
        criticalAtStartup?: boolean;
        reconciliationEnabled?: boolean;
      };

      const wallet = await registerWallet(walletDeps, {
        role: actor.role,
        projectId: body.projectId,
        environmentId: body.environmentId,
        chainId: body.chainId,
        walletRole: body.role,
        address: body.address,
        criticalAtStartup: body.criticalAtStartup ?? false,
        reconciliationEnabled: body.reconciliationEnabled ?? false,
        operationId: request.id,
        actorId: actor.credentialId,
        sourceIp: request.ip,
      });

      return { data: serializeManagedWallet(wallet) };
    },
  );

  app.get(
    '/v1/wallets',
    {
      preHandler: app.authenticate,
      schema: {
        // Query values arrive as strings (global coerceTypes is false).
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', format: 'uuid' },
            environmentId: { type: 'string', format: 'uuid' },
            enabled: { type: 'string', enum: ['true', 'false'] },
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
                items: managedWalletResponseSchema,
              },
              pagination: paginationResponseSchema,
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
        enabled?: 'true' | 'false';
        limit?: string;
        offset?: string;
      };

      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);

      const page = await listWallets(
        { managedWallets: container.repositories.managedWallets },
        {
          role: actor.role,
          filter: {
            projectId: query.projectId,
            environmentId: query.environmentId,
            enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
          },
          limit,
          offset,
        },
      );

      return {
        data: page.items.map(serializeManagedWallet),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  /**
   * Live on-chain ETH balance for one managed wallet (C17 / TX.13).
   *
   * Fresh RPC read; does not write balance_observations. Unavailable reads
   * return HTTP 200 with outcome `unavailable` — never wei "0".
   */
  app.get(
    '/v1/wallets/:id/balance',
    {
      preHandler: app.authenticate,
      schema: {
        params: walletIdParams,
        response: {
          200: walletBalanceResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const result = await readWalletBalance(
        {
          managedWallets: container.repositories.managedWallets,
          credentialScopes: container.repositories.credentialScopes,
          balanceReader: container.balanceReader,
        },
        {
          role: actor.role,
          credentialId: actor.credentialId,
          walletId: id,
        },
      );

      if (result.reading.kind === 'unavailable') {
        return {
          balance: {
            outcome: 'unavailable' as const,
            errorCode: result.reading.errorCode,
            reason: result.reading.reason,
            observedAt: result.reading.observedAt.toISOString(),
          },
        };
      }

      return {
        balance: {
          outcome: 'observed' as const,
          wei: result.reading.balanceWei.toString(),
          ether: formatWeiAsEther(result.reading.balanceWei),
          blockNumber: result.reading.blockNumber.toString(),
          observedAt: result.reading.observedAt.toISOString(),
        },
      };
    },
  );

  app.patch(
    '/v1/wallets/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: walletIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            enabled: { type: 'boolean' },
            criticalAtStartup: { type: 'boolean' },
            reconciliationEnabled: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: managedWalletResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        enabled?: boolean;
        criticalAtStartup?: boolean;
        reconciliationEnabled?: boolean;
      };

      const wallet = await updateWallet(
        {
          operatorMutations: container.operatorMutations,
        },
        {
          role: actor.role,
          walletId: id,
          patch: {
            enabled: body.enabled,
            criticalAtStartup: body.criticalAtStartup,
            reconciliationEnabled: body.reconciliationEnabled,
          },
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
        },
      );

      return { data: serializeManagedWallet(wallet) };
    },
  );

  app.put(
    '/v1/wallets/:id/policy',
    {
      preHandler: app.authenticate,
      schema: {
        params: walletIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['minimumBalanceWei', 'targetBalanceWei', 'maximumTopUpWei'],
          properties: {
            minimumBalanceWei: weiDecimalString,
            targetBalanceWei: weiDecimalString,
            maximumTopUpWei: weiDecimalString,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: managedWalletResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        minimumBalanceWei: string;
        targetBalanceWei: string;
        maximumTopUpWei: string;
      };

      // Parse once at the HTTP boundary; services receive bigint only.
      const wallet = await setWalletPolicy(
        {
          operatorMutations: container.operatorMutations,
        },
        {
          role: actor.role,
          walletId: id,
          minimumBalanceWei: parseWeiDecimalString(body.minimumBalanceWei, 'minimumBalanceWei'),
          targetBalanceWei: parseWeiDecimalString(body.targetBalanceWei, 'targetBalanceWei'),
          maximumTopUpWei: parseWeiDecimalString(body.maximumTopUpWei, 'maximumTopUpWei'),
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
        },
      );

      return { data: serializeManagedWallet(wallet) };
    },
  );

  /**
   * On-demand funding for one managed wallet (P1-US3).
   *
   * Destination address is never accepted from the client — only the wallet id
   * in the path, resolved via ManagedWalletRepository (AGENTS.md §7.1).
   */
  app.post(
    '/v1/wallets/:id/ensure-funded',
    {
      preHandler: app.authenticate,
      schema: {
        params: walletIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idempotencyKey'],
          properties: {
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: ensureFundedResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { idempotencyKey: string };

      const result = await ensureWalletFunded(
        {
          managedWallets: container.repositories.managedWallets,
          treasuries: container.repositories.treasuries,
          balanceObservations: container.repositories.balanceObservations,
          balanceReader: container.balanceReader,
          credentialScopes: container.repositories.credentialScopes,
          auditEvents: container.repositories.auditEvents,
          alerts: container.repositories.alerts,
          emailSender: container.emailSender,
          operations: container.repositories.fundingOperations,
          transactions: container.repositories.fundingTransactions,
          lock: container.fundingDispatchLock,
          receiptTracker: container.transactionReceiptTracker,
          signer: container.treasurySigner,
          clock: container.clock,
          idGenerator: container.idGenerator,
          logger: container.logger,
          isFundingEnabled: container.config.isFundingEnabled,
          isFundingKillSwitchActive: container.config.isFundingKillSwitchActive,
          confirmations: container.config.funding.confirmations,
          confirmationTimeoutMs: container.config.funding.confirmationTimeoutMs,
          operatorRecipients: container.config.email?.operatorRecipients ?? [],
          dashboardBaseUrl: container.config.app.publicBaseUrl,
          environment: container.config.app.environment,
        },
        {
          walletId: id,
          idempotencyKey: body.idempotencyKey,
          role: actor.role,
          credentialId: actor.credentialId,
          correlationId: request.id,
          sourceIp: request.ip,
        },
      );

      return {
        data: {
          status: result.status,
          operationId: result.operationId,
          balanceBeforeWei: result.balanceBeforeWei.toString(),
          minimumBalanceWei: result.minimumBalanceWei.toString(),
          targetBalanceWei: result.targetBalanceWei.toString(),
          transferredWei: result.transferredWei === undefined ? null : result.transferredWei.toString(),
          transactionHash: result.transactionHash ?? null,
          explorerUrl:
            result.transactionHash === undefined
              ? null
              : `${result.explorerBaseUrl}/tx/${result.transactionHash}`,
          reasonCode: result.reasonCode ?? null,
        },
      };
    },
  );
}
