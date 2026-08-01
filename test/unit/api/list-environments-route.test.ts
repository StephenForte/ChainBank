import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedActor } from '../../../src/app/auth/authenticate-credential.js';
import { listEnvironments } from '../../../src/app/projects/list-environments.js';
import type { CredentialScope, Environment, Project } from '../../../src/app/ports.js';
import { registerErrorHandler } from '../../../src/api/plugins/error-handler.js';
import { requireActor } from '../../../src/api/plugins/authentication.js';
import {
  paginationQuerySchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../../../src/api/pagination.js';
import { serializeEnvironment } from '../../../src/api/serializers/project.js';
import type { AppInstance } from '../../../src/api/types.js';
import { createLogger } from '../../../src/observability/logger.js';

const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ENV_A1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const now = new Date('2026-07-28T12:00:00.000Z');

const project: Project = {
  id: PROJECT_A,
  slug: 'fortel2',
  name: 'ForteL2',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const environment: Environment = {
  id: ENV_A1,
  projectId: PROJECT_A,
  slug: 'fresh',
  name: 'Fresh Environment',
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

const environmentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'projectId', 'slug', 'name', 'enabled', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const paginationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['limit', 'offset', 'total'],
  properties: {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    total: { type: 'integer' },
  },
} as const;

async function buildRouteApp(options: {
  readonly actor: AuthenticatedActor;
  readonly scopes?: readonly CredentialScope[];
  readonly environments?: readonly Environment[];
}): Promise<AppInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    loggerInstance: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    requestIdHeader: false,
    genReqId: () => 'req-test-list-env',
  }) as AppInstance;

  registerErrorHandler(app);

  const listByProject = vi.fn((_projectId: string, pagination: { limit: number; offset: number }) =>
    Promise.resolve({
      items: (options.environments ?? [environment]).slice(
        pagination.offset,
        pagination.offset + pagination.limit,
      ),
      total: (options.environments ?? [environment]).length,
    }),
  );

  app.get(
    '/v1/projects/:id/environments',
    {
      preHandler: (request, _reply, done) => {
        request.actor = options.actor;
        done();
      },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
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
              data: { type: 'array', items: environmentResponseSchema },
              pagination: paginationResponseSchema,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const query = request.query as PaginationQuery;
      const limit = parsePageLimit(query.limit);
      const offset = parsePageOffset(query.offset);

      const page = await listEnvironments(
        {
          projects: {
            insert: vi.fn(),
            findById: vi.fn((projectId: string) =>
              Promise.resolve(projectId === PROJECT_A ? project : undefined),
            ),
            findBySlug: vi.fn(),
            list: vi.fn(),
            listByIds: vi.fn(),
            setEnabled: vi.fn(),
          },
          environments: {
            insert: vi.fn(),
            findById: vi.fn(),
            listByProject,
            setEnabled: vi.fn(),
          },
          credentialScopes: {
            listByCredentialId: vi.fn(() => Promise.resolve(options.scopes ?? [])),
            insert: vi.fn(),
          },
        },
        {
          role: actor.role,
          credentialId: actor.credentialId,
          projectId: id,
          limit,
          offset,
        },
      );

      return {
        data: page.items.map(serializeEnvironment),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  await app.ready();
  return app;
}

describe('GET /v1/projects/:id/environments route', () => {
  it('validates and paginates ?limit=50&offset=0 as strings (PR #18 regression class)', async () => {
    const app = await buildRouteApp({
      actor: { credentialId: CREDENTIAL_ID, name: 'op', role: 'operator' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_A}/environments?limit=50&offset=0`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [serializeEnvironment(environment)],
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    await app.close();
  });

  it('rejects integer-typed pagination query values under coerceTypes: false', async () => {
    const app = Fastify({
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    });
    app.get(
      '/probe',
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', minimum: 1 },
              offset: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      () => ({ ok: true }),
    );
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/probe?limit=50&offset=0',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
