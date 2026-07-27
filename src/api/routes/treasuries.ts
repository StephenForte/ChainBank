import type { AppInstance } from '../types.js';
import { checkTreasuryBalance } from '../../app/treasury/check-treasury-balance.js';
import { listTreasuries } from '../../app/treasury/list-treasuries.js';
import type { Container } from '../../container.js';
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
