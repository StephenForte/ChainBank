import type { AppInstance } from '../types.js';
import { acknowledgeAlert, MAX_ACKNOWLEDGEMENT_NOTE_LENGTH } from '../../app/alerts/acknowledge-alert.js';
import { acknowledgeFinding, MAX_FINDING_ENTITY_ID_LENGTH } from '../../app/alerts/acknowledge-finding.js';
import { listAlerts } from '../../app/alerts/list-alerts.js';
import type { AlertLifecycleState } from '../../app/ports.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeAlert } from '../serializers/alert.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../pagination.js';

const ALERT_LIFECYCLE_STATES = ['open', 'resolved', 'acknowledged'] as const;

const alertIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const alertResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'alertType',
    'severity',
    'entityType',
    'entityId',
    'state',
    'firstTriggeredAt',
    'lastEvaluatedAt',
    'lastSentAt',
    'resolvedAt',
    'acknowledgedAt',
    'acknowledgedBy',
    'acknowledgementNote',
    'metadata',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    alertType: { type: 'string' },
    severity: { type: 'string' },
    entityType: { type: 'string' },
    entityId: { type: 'string' },
    state: { type: 'string' },
    firstTriggeredAt: { type: 'string', format: 'date-time' },
    lastEvaluatedAt: { type: 'string', format: 'date-time' },
    lastSentAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    resolvedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    acknowledgedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    acknowledgedBy: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    acknowledgementNote: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    // Opaque at rest — same fail-permissive stance as C19 findings.
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

interface AlertsQuery extends PaginationQuery {
  readonly alertType?: string;
  readonly state?: string;
  readonly entityType?: string;
}

function parseOptionalLifecycleState(raw: string | undefined): AlertLifecycleState | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if ((ALERT_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return raw as AlertLifecycleState;
  }
  throw new ChainBankError('INVALID_REQUEST', `state must be one of ${ALERT_LIFECYCLE_STATES.join(', ')}`, {
    publicMessage: `state must be one of: ${ALERT_LIFECYCLE_STATES.join(', ')}.`,
  });
}

export function registerAlertRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/alerts',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...paginationQuerySchema,
            alertType: { type: 'string', minLength: 1, maxLength: 64 },
            state: { type: 'string', minLength: 1, maxLength: 32 },
            entityType: { type: 'string', minLength: 1, maxLength: 64 },
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
                items: alertResponseSchema,
              },
              pagination: paginationResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const query = request.query as AlertsQuery;
      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);
      const state = parseOptionalLifecycleState(query.state);

      const page = await listAlerts(
        { alerts: container.repositories.alerts },
        {
          role: actor.role,
          limit,
          offset,
          ...(query.alertType !== undefined ? { alertType: query.alertType } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(query.entityType !== undefined ? { entityType: query.entityType } : {}),
        },
      );

      return {
        data: page.items.map(serializeAlert),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  // Static path before /:id/acknowledge so "acknowledge-finding" is never
  // parsed as a UUID param.
  app.post(
    '/v1/alerts/acknowledge-finding',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['entityId', 'note'],
          properties: {
            entityId: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_FINDING_ENTITY_ID_LENGTH,
            },
            note: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_ACKNOWLEDGEMENT_NOTE_LENGTH,
            },
            // Opaque forensic fields for persist-only row creation (C19 stance).
            metadata: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: alertResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const body = request.body as {
        entityId: string;
        note: string;
        metadata?: Record<string, unknown>;
      };

      const alert = await acknowledgeFinding(
        {
          operatorMutations: container.operatorMutations,
          clock: container.clock,
        },
        {
          role: actor.role,
          entityId: body.entityId,
          note: body.note,
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        },
      );

      return { data: serializeAlert(alert) };
    },
  );

  app.post(
    '/v1/alerts/:id/acknowledge',
    {
      preHandler: app.authenticate,
      schema: {
        params: alertIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['note'],
          properties: {
            note: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_ACKNOWLEDGEMENT_NOTE_LENGTH,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: {
              data: alertResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { note: string };

      const alert = await acknowledgeAlert(
        {
          operatorMutations: container.operatorMutations,
          clock: container.clock,
        },
        {
          role: actor.role,
          alertId: id,
          note: body.note,
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
        },
      );

      return { data: serializeAlert(alert) };
    },
  );
}
