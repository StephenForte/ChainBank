import type { AppInstance } from '../types.js';
import { listCredentials } from '../../app/credentials/list-credentials.js';
import { mutateCredential } from '../../app/credentials/mutate-credential.js';
import { sendTestEmail } from '../../app/admin/send-test-email.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeCredentialSummary } from '../serializers/credential.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const credentialResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'role', 'tokenPrefix', 'enabled', 'revokedAt', 'lastUsedAt', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    role: { type: 'string' },
    tokenPrefix: { type: 'string' },
    enabled: { type: 'boolean' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export function registerAdminRoutes(app: AppInstance, container: Container): void {
  const credentialDeps = {
    apiCredentials: container.repositories.apiCredentials,
    auditEvents: container.repositories.auditEvents,
    clock: container.clock,
  };

  app.get(
    '/v1/admin/credentials',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT },
            offset: { type: 'integer', minimum: 0 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: credentialResponseSchema },
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
      const query = request.query as { limit?: number; offset?: number };
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const offset = query.offset ?? 0;

      const page = await listCredentials(credentialDeps, {
        role: actor.role,
        limit,
        offset,
      });

      return {
        data: page.items.map(serializeCredentialSummary),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  app.patch(
    '/v1/admin/credentials/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['disable', 'revoke'] },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: credentialResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const body = request.body as { action: 'disable' | 'revoke' };

      const credential = await mutateCredential(credentialDeps, {
        role: actor.role,
        credentialId: params.id,
        actorCredentialId: actor.credentialId,
        action: body.action,
        operationId: request.id,
        sourceIp: request.ip,
      });

      return { data: serializeCredentialSummary(credential) };
    },
  );

  /**
   * Sends the configured operator recipients a test message.
   *
   * The body must be empty. Recipients come from validated configuration, so
   * there is no request field through which a caller could redirect mail.
   */
  app.post(
    '/v1/admin/email/test',
    {
      preHandler: app.authenticate,
      schema: {
        body: { type: 'object', additionalProperties: false, properties: {}, nullable: true },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { config, emailSender } = container;

      if (emailSender === undefined || config.email === undefined) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          'This process was started without email configuration',
          { publicMessage: 'Email is not configured for this service.' },
        );
      }

      const result = await sendTestEmail(
        {
          emailSender,
          auditEvents: container.repositories.auditEvents,
          clock: container.clock,
        },
        {
          role: actor.role,
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
          recipients: config.email.operatorRecipients,
          environment: config.app.environment,
          chainDisplayName: config.chain.displayName,
          treasuryAddressDisplay: config.treasury.address,
          dashboardUrl: config.app.publicBaseUrl,
        },
      );

      return {
        data: {
          // The recipient list itself is not echoed back; the count is enough
          // to confirm the action without restating configured addresses.
          recipientCount: result.recipientCount,
          sentAt: result.sentAt.toISOString(),
          provider: config.email.provider,
        },
      };
    },
  );
}
