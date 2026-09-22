import type { AppInstance } from '../types.js';
import { listEmailTriggers, type EmailTriggersDescription } from '../../app/email/describe-email-triggers.js';
import { listEmailDeliveries } from '../../app/email/list-email-deliveries.js';
import {
  EMAIL_DELIVERY_KINDS,
  UNKNOWN_EMAIL_DELIVERY_KIND,
  type EmailDeliveryStatus,
  type StoredEmailDelivery,
} from '../../app/ports.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../pagination.js';

const DELIVERY_KINDS = [...EMAIL_DELIVERY_KINDS, UNKNOWN_EMAIL_DELIVERY_KIND] as const;

const deliveryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sentAt',
    'kind',
    'recipients',
    'subject',
    'status',
    'providerMessageId',
    'errorCode',
    'errorSummary',
    'relatedEntityType',
    'relatedEntityId',
    'correlationId',
    'serviceRole',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    sentAt: { type: 'string', format: 'date-time' },
    kind: { type: 'string' },
    recipients: { type: 'array', items: { type: 'string' } },
    subject: { type: 'string' },
    status: { type: 'string', enum: ['sent', 'failed'] },
    providerMessageId: { type: ['string', 'null'] },
    errorCode: { type: ['string', 'null'] },
    errorSummary: { type: ['string', 'null'] },
    relatedEntityType: { type: ['string', 'null'] },
    relatedEntityId: { type: ['string', 'null'] },
    correlationId: { type: ['string', 'null'] },
    serviceRole: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const triggerRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'scope', 'condition', 'recipients'],
  properties: {
    trigger: { type: 'string' },
    scope: { type: 'string' },
    condition: { type: 'string' },
    recipients: { type: 'array', items: { type: 'string' } },
  },
} as const;

interface DeliveriesQuery extends PaginationQuery {
  readonly status?: string;
  readonly kind?: string;
}

export function registerAdminEmailRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/admin/email/deliveries',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...paginationQuerySchema,
            status: { type: 'string', minLength: 1, maxLength: 32 },
            kind: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: deliveryResponseSchema },
              pagination: paginationResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const deliveries = container.repositories.emailDeliveries;
      if (deliveries === undefined) {
        throw new ChainBankError('INVALID_CONFIGURATION', 'Email delivery repository is not configured', {
          publicMessage: 'Email is not configured for this service.',
        });
      }
      const query = request.query as DeliveriesQuery;
      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);
      const status = parseOptionalStatus(query.status);
      const kind = parseOptionalKind(query.kind);
      const page = await listEmailDeliveries(
        { emailDeliveries: deliveries },
        {
          role: actor.role,
          limit,
          offset,
          ...(status !== undefined ? { status } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
      );
      return {
        data: page.items.map(serializeDelivery),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  app.get(
    '/v1/admin/email/triggers',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['triggers', 'recipients', 'fromAddress', 'provider'],
                properties: {
                  triggers: { type: 'array', items: triggerRowSchema },
                  recipients: { type: 'array', items: { type: 'string' } },
                  fromAddress: { type: 'string' },
                  provider: { type: 'string', enum: ['resend', 'log-only'] },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const description = await listEmailTriggers(
        {
          treasuries: container.repositories.treasuries,
          email: container.config.email,
          reminderIntervalMs: container.config.alerts.reminderIntervalMs,
          reconcileFailureAlertThreshold: container.config.alerts.reconcileFailureAlertThreshold,
        },
        { role: actor.role },
      );
      return { data: serializeTriggers(description) };
    },
  );
}

function parseOptionalStatus(raw: string | undefined): EmailDeliveryStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'sent' || raw === 'failed') {
    return raw;
  }
  throw new ChainBankError('INVALID_REQUEST', 'status must be sent or failed', {
    publicMessage: 'status must be sent or failed.',
  });
}

function parseOptionalKind(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if ((DELIVERY_KINDS as readonly string[]).includes(raw)) {
    return raw;
  }
  throw new ChainBankError('INVALID_REQUEST', `kind must be one of ${DELIVERY_KINDS.join(', ')}`, {
    publicMessage: `kind must be one of: ${DELIVERY_KINDS.join(', ')}.`,
  });
}

function serializeDelivery(row: StoredEmailDelivery) {
  return {
    id: row.id,
    sentAt: row.sentAt.toISOString(),
    kind: row.kind,
    recipients: [...row.recipients],
    subject: row.subject,
    status: row.status,
    providerMessageId: row.providerMessageId ?? null,
    errorCode: row.errorCode ?? null,
    errorSummary: row.errorSummary ?? null,
    relatedEntityType: row.relatedEntityType ?? null,
    relatedEntityId: row.relatedEntityId ?? null,
    correlationId: row.correlationId ?? null,
    serviceRole: row.serviceRole,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeTriggers(description: EmailTriggersDescription) {
  return {
    triggers: description.triggers.map((row) => ({
      trigger: row.trigger,
      scope: row.scope,
      condition: row.condition,
      recipients: [...row.recipients],
    })),
    recipients: [...description.recipients],
    fromAddress: description.fromAddress,
    provider: description.provider,
  };
}
