import type { AppInstance } from '../types.js';
import { evaluateTreasuryAlerts } from '../../app/alerts/evaluate-treasury-alerts.js';
import { checkTreasuryBalance } from '../../app/treasury/check-treasury-balance.js';
import { listTreasuries } from '../../app/treasury/list-treasuries.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
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
          balanceObservations: container.repositories.balanceObservations,
          balanceReader: container.balanceReader,
          auditEvents: container.repositories.auditEvents,
        },
        {
          treasuryId: id,
          role: actor.role,
          operationId: request.id,
          actor: { type: 'api_credential', id: actor.credentialId },
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
            actor: { type: 'api_credential', id: actor.credentialId },
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
