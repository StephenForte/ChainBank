import type { AppInstance } from '../types.js';
import { createDashboardUser } from '../../app/users/create-user.js';
import { listDashboardUsers } from '../../app/users/list-users.js';
import { updateDashboardUser } from '../../app/users/update-user.js';
import type { DashboardUserSummary } from '../../app/ports.js';
import type { DashboardRole } from '../../domain/auth/users.js';
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
import { requireDashboardUsers } from './auth.js';

const DASHBOARD_ROLES = ['admin', 'operator', 'viewer'] as const;

const userResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'email', 'displayName', 'role', 'enabled', 'createdAt', 'updatedAt', 'lastLoginAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: [...DASHBOARD_ROLES] },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

export function registerAdminUserRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/v1/admin/users',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { ...paginationQuerySchema },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: userResponseSchema },
              pagination: paginationResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireDashboardActor(requireActor(request));
      const query = request.query as PaginationQuery;
      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);
      const page = await listDashboardUsers(
        { users: requireDashboardUsers(container) },
        { actor, limit, offset },
      );
      return {
        data: page.items.map(serializeUser),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  app.post(
    '/v1/admin/users',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'displayName', 'role', 'password'],
          properties: {
            email: { type: 'string', minLength: 1, maxLength: 320 },
            displayName: { type: 'string', minLength: 1, maxLength: 200 },
            role: { type: 'string', enum: [...DASHBOARD_ROLES] },
            password: { type: 'string', minLength: 12, maxLength: 1024 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: userResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireDashboardActor(requireActor(request));
      const body = request.body as {
        email: string;
        displayName: string;
        role: DashboardRole;
        password: string;
      };
      const user = await createDashboardUser(
        { operatorMutations: container.operatorMutations },
        {
          actor,
          actorUserId: actor.userId,
          email: body.email,
          displayName: body.displayName,
          role: body.role,
          password: body.password,
          now: container.clock.now(),
          operationId: request.id,
          sourceIp: request.ip,
        },
      );
      return { data: serializeUser(user) };
    },
  );

  app.patch(
    '/v1/admin/users/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            role: { type: 'string', enum: [...DASHBOARD_ROLES] },
            password: { type: 'string', minLength: 12, maxLength: 1024 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: userResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireDashboardActor(requireActor(request));
      const params = request.params as { id: string };
      const body = request.body as { enabled?: boolean; role?: DashboardRole; password?: string };
      const user = await updateDashboardUser(
        { operatorMutations: container.operatorMutations },
        {
          actor,
          actorUserId: actor.userId,
          ...(actor.sessionId === undefined ? {} : { actorSessionId: actor.sessionId }),
          userId: params.id,
          now: container.clock.now(),
          operationId: request.id,
          sourceIp: request.ip,
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.password === undefined ? {} : { password: body.password }),
        },
      );
      return { data: serializeUser(user) };
    },
  );
}

function requireDashboardActor(actor: ReturnType<typeof requireActor>): ReturnType<typeof requireActor> & {
  readonly userId: string;
} {
  if (actor.kind !== 'dashboard_user' || actor.userId === undefined) {
    throw new ChainBankError(
      'INSUFFICIENT_ROLE',
      'Dashboard user administration requires a dashboard admin',
      {
        publicMessage: 'You do not have permission to manage users.',
      },
    );
  }
  return { ...actor, userId: actor.userId };
}

function serializeUser(user: DashboardUserSummary): {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
