import type { AppInstance } from '../types.js';
import { requestAuditActor } from '../../app/auth/request-audit-actor.js';
import { evaluateTreasuryAlerts } from '../../app/alerts/evaluate-treasury-alerts.js';
import { checkTreasuryBalance } from '../../app/treasury/check-treasury-balance.js';
import { listTreasuries } from '../../app/treasury/list-treasuries.js';
import { setTreasuryEnabled } from '../../app/treasury/set-treasury-enabled.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import { assertPermission } from '../../domain/auth/roles.js';
import { ensureOperationalTreasuryFunded } from '../../app/funding/ensure-operational-treasury-funded.js';
import { serializeTreasury } from '../serializers/treasury.js';

const treasuryIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export function registerTreasuryRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/treasuries',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const treasuries = await listTreasuries(
        { treasuries: container.repositories.treasuries },
        { role: actor.role },
      );
      return { data: treasuries.map(serializeTreasury) };
    },
  );

  app.patch(
    '/v1/treasuries/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: treasuryIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { enabled: boolean };

      const treasury = await setTreasuryEnabled(
        {
          operatorMutations: container.operatorMutations,
        },
        {
          role: actor.role,
          treasuryId: id,
          enabled: body.enabled,
          operationId: request.id,
          actorId: requestAuditActor(actor).id,
          actorType: requestAuditActor(actor).type,
          sourceIp: request.ip,
        },
      );

      return { data: serializeTreasury(treasury) };
    },
  );

  app.post(
    '/v1/treasuries/:id/replenish',
    {
      preHandler: app.authenticate,
      schema: {
        params: treasuryIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idempotencyKey'],
          properties: {
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      assertPermission(actor.role, 'treasury:replenish');
      const { id } = request.params as { id: string };
      const body = request.body as { idempotencyKey: string };

      const result = await ensureOperationalTreasuryFunded(
        {
          treasuries: container.repositories.treasuries,
          balanceObservations: container.repositories.balanceObservations,
          chainAdapters: container.chainAdapters,
          auditEvents: container.repositories.auditEvents,
          alerts: container.repositories.alerts,
          emailSender: container.emailSender,
          operations: container.repositories.fundingOperations,
          transactions: container.repositories.fundingTransactions,
          managedWallets: container.repositories.managedWallets,
          lock: container.fundingDispatchLock,
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
          operationalTreasuryId: id,
          idempotencyKey: body.idempotencyKey,
          role: actor.role,
          credentialId: actor.credentialId,
          actorType: requestAuditActor(actor).type,
          correlationId: request.id,
          sourceIp: request.ip,
        },
      );

      return {
        data: {
          status: result.status,
          operationId: result.operationId,
          sourceTreasuryId: result.sourceTreasuryId,
          destinationTreasuryId: result.destinationTreasuryId,
          balanceBeforeWei: result.balanceBeforeWei.toString(),
          minimumBalanceWei: result.minimumBalanceWei.toString(),
          targetBalanceWei: result.targetBalanceWei.toString(),
          transferredWei: result.transferredWei?.toString() ?? null,
          transactionHash: result.transactionHash ?? null,
          explorerBaseUrl: result.explorerBaseUrl,
          reasonCode: result.reasonCode ?? null,
        },
      };
    },
  );

  /**
   * Manual "check now".
   *
   * Mutating in the HTTP sense because it writes an observation, but strictly
   * read-only against the chain: it reads a balance and records what it saw.
   * Alert transitions (including recovery) run through the same application
   * service as the treasury-monitor cron (PRD P3-US3).
   */
  app.post(
    '/v1/treasuries/:id/check',
    {
      preHandler: app.authenticate,
      schema: {
        params: treasuryIdParams,
        body: { type: 'object', additionalProperties: false, properties: {}, nullable: true },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const result = await checkTreasuryBalance(
        {
          treasuries: container.repositories.treasuries,
          chainAdapters: container.chainAdapters,
          operatorMutations: container.operatorMutations,
        },
        {
          treasuryId: id,
          role: actor.role,
          operationId: request.id,
          actor: requestAuditActor(actor),
        },
      );

      if (result.reading.kind === 'observed') {
        const { config, emailSender } = container;
        if (emailSender === undefined || config.email === undefined) {
          throw new ChainBankError(
            'INVALID_CONFIGURATION',
            'This process was started without email configuration',
            { publicMessage: 'Email is not configured for this service.' },
          );
        }

        await evaluateTreasuryAlerts(
          {
            alerts: container.repositories.alerts,
            emailSender,
            auditEvents: container.repositories.auditEvents,
            clock: container.clock,
          },
          {
            treasury: result.treasury,
            balanceWei: result.reading.balanceWei,
            reminderIntervalMs: config.alerts.reminderIntervalMs,
            operatorRecipients: config.email.operatorRecipients,
            dashboardBaseUrl: config.app.publicBaseUrl,
            environment: config.app.environment,
            operationId: request.id,
            actor: requestAuditActor(actor),
          },
        );
      }

      return {
        data: serializeTreasury(result.treasury),
        check:
          result.reading.kind === 'observed'
            ? {
                outcome: 'observed' as const,
                observedAt: result.reading.observedAt.toISOString(),
                blockNumber: result.reading.blockNumber.toString(),
              }
            : {
                outcome: 'unavailable' as const,
                observedAt: result.reading.observedAt.toISOString(),
                errorCode: result.reading.errorCode,
                reason: result.reading.reason,
              },
      };
    },
  );
}
