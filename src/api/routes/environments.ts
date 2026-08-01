import type { AppInstance } from '../types.js';
import { ensureEnvironmentReady } from '../../app/funding/ensure-environment-ready.js';
import type { Container } from '../../container.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeEnsureReady } from '../serializers/ensure-ready.js';

const environmentIdParams = {
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

const ensureReadyWalletSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'walletId',
    'address',
    'criticalAtStartup',
    'status',
    'operationId',
    'reasonCode',
    'errorCode',
    'balanceBeforeWei',
    'minimumBalanceWei',
    'targetBalanceWei',
    'transferredWei',
    'transactionHash',
  ],
  properties: {
    walletId: { type: 'string', format: 'uuid' },
    address: { type: 'string' },
    criticalAtStartup: { type: 'boolean' },
    status: { type: 'string', enum: ['no-op', 'funded', 'pending', 'warning', 'blocked'] },
    operationId: { anyOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] },
    reasonCode: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    errorCode: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    balanceBeforeWei: { anyOf: [{ type: 'null' }, weiDecimalString] },
    minimumBalanceWei: { anyOf: [{ type: 'null' }, weiDecimalString] },
    targetBalanceWei: { anyOf: [{ type: 'null' }, weiDecimalString] },
    transferredWei: { anyOf: [{ type: 'null' }, weiDecimalString] },
    transactionHash: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 66, maxLength: 66 }] },
  },
} as const;

const ensureReadyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'environmentId', 'projectId', 'wallets'],
  properties: {
    status: { type: 'string', enum: ['ready', 'degraded', 'pending', 'blocked'] },
    environmentId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    wallets: { type: 'array', items: ensureReadyWalletSchema },
  },
} as const;

/**
 * Environment readiness routes (P2-US2). Kept in a dedicated file so concurrent
 * project-admin work on `projects.ts` does not collide.
 */
export function registerEnvironmentRoutes(app: AppInstance, container: Container): void {
  /**
   * One call ensures all enabled wallets in an environment are ready for startup.
   *
   * Destination addresses are never accepted from the client — each wallet is
   * funded via ensureWalletFunded / ManagedWalletRepository (AGENTS.md §7.1).
   * The caller's idempotency key is passed through and namespaced per wallet
   * inside ensureWalletFunded (`${walletId}:${key}`).
   */
  app.post(
    '/v1/environments/:id/ensure-ready',
    {
      preHandler: app.authenticate,
      schema: {
        params: environmentIdParams,
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
              data: ensureReadyResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { idempotencyKey: string };

      const result = await ensureEnvironmentReady(
        {
          environments: container.repositories.environments,
          projects: container.repositories.projects,
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
          environmentId: id,
          idempotencyKey: body.idempotencyKey,
          role: actor.role,
          credentialId: actor.credentialId,
          correlationId: request.id,
          sourceIp: request.ip,
        },
      );

      return { data: serializeEnsureReady(result) };
    },
  );
}
