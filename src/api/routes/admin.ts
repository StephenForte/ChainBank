import type { AppInstance } from '../types.js';
import { requestAuditActor } from '../../app/auth/request-audit-actor.js';
import { listCredentials } from '../../app/credentials/list-credentials.js';
import { mutateCredential } from '../../app/credentials/mutate-credential.js';
import { sendTestEmail } from '../../app/admin/send-test-email.js';
import type { ConfiguredChain } from '../../config/index.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeCredentialSummary } from '../serializers/credential.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../pagination.js';

/**
 * Copy for the operator test email. One message names every configured chain
 * and that chain's treasury. A per-chain message would look like several
 * incidents and would multiply the provider call this probe exists to make.
 *
 * One chain keeps today's two lines: the chain's display name, and its
 * external treasury address. Several chains put each chain's name on the
 * chain line and `Name address` (plus ` / Private address` when that chain
 * is two-tier) on the treasury line. Reversing this copy is this function.
 */
export function formatTestEmailChains(chains: readonly ConfiguredChain[]): {
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
} {
  const only = chains.length === 1 ? chains[0] : undefined;
  if (only !== undefined) {
    return {
      chainDisplayName: only.displayName,
      treasuryAddressDisplay: only.treasury.address,
    };
  }
  if (chains.length === 0) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'No chain is configured', {
      publicMessage: 'The service is misconfigured.',
    });
  }
  return {
    chainDisplayName: chains.map((chain) => chain.displayName).join(', '),
    treasuryAddressDisplay: chains
      .map((chain) => {
        const external = `${chain.displayName} ${chain.treasury.address}`;
        const operational = chain.operationalTreasury;
        return operational === undefined ? external : `${external} / Private ${operational.address}`;
      })
      .join('; '),
  };
}

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
    operatorMutations: container.operatorMutations,
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
            ...paginationQuerySchema,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: credentialResponseSchema },
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
            action: { type: 'string', enum: ['disable', 'revoke', 'enable'] },
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
        actorCredentialId: requestAuditActor(actor).id,
        actorType: requestAuditActor(actor).type,
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
          actorId: requestAuditActor(actor).id,
          actorType: requestAuditActor(actor).type,
          sourceIp: request.ip,
          recipients: config.email.operatorRecipients,
          environment: config.app.environment,
          ...formatTestEmailChains(config.chains),
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
