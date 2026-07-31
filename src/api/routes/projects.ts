import type { AppInstance } from '../types.js';
import { createEnvironment } from '../../app/projects/create-environment.js';
import { createProject } from '../../app/projects/create-project.js';
import { getEnvironment } from '../../app/projects/get-environment.js';
import { getProject } from '../../app/projects/get-project.js';
import { listProjects } from '../../app/projects/list-projects.js';
import { setEnvironmentEnabled } from '../../app/projects/set-environment-enabled.js';
import { setProjectEnabled } from '../../app/projects/set-project-enabled.js';
import type { Container } from '../../container.js';
import { requireActor } from '../plugins/authentication.js';
import { serializeEnvironment, serializeProject } from '../serializers/project.js';
import {
  paginationQuerySchema,
  paginationResponseSchema,
  parsePageLimit,
  parsePageOffset,
  type PaginationQuery,
} from '../pagination.js';

const projectIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const environmentIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const slugPattern = {
  type: 'string',
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
} as const;

const projectResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'name', 'enabled', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: slugPattern,
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const environmentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'projectId', 'slug', 'name', 'enabled', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    slug: slugPattern,
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export function registerProjectRoutes(app: AppInstance, container: Container): void {
  const projectDeps = {
    projects: container.repositories.projects,
    environments: container.repositories.environments,
    credentialScopes: container.repositories.credentialScopes,
    auditEvents: container.repositories.auditEvents,
  };

  app.get(
    '/v1/projects',
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
              data: { type: 'array', items: projectResponseSchema },
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

      const page = await listProjects(projectDeps, {
        role: actor.role,
        credentialId: actor.credentialId,
        limit,
        offset,
      });

      return {
        data: page.items.map(serializeProject),
        pagination: { limit, offset, total: page.total },
      };
    },
  );

  app.post(
    '/v1/projects',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'name'],
          properties: {
            slug: slugPattern,
            name: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: projectResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const body = request.body as { slug: string; name: string };

      const project = await createProject(projectDeps, {
        role: actor.role,
        slug: body.slug,
        name: body.name,
        operationId: request.id,
        actorId: actor.credentialId,
        sourceIp: request.ip,
      });

      return { data: serializeProject(project) };
    },
  );

  app.get(
    '/v1/projects/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: projectIdParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: projectResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const project = await getProject(projectDeps, {
        role: actor.role,
        credentialId: actor.credentialId,
        projectId: id,
      });

      return { data: serializeProject(project) };
    },
  );

  app.patch(
    '/v1/projects/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: projectIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: projectResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { enabled: boolean };

      const project = await setProjectEnabled(projectDeps, {
        role: actor.role,
        projectId: id,
        enabled: body.enabled,
        operationId: request.id,
        actorId: actor.credentialId,
        sourceIp: request.ip,
      });

      return { data: serializeProject(project) };
    },
  );

  app.post(
    '/v1/projects/:id/environments',
    {
      preHandler: app.authenticate,
      schema: {
        params: projectIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'name'],
          properties: {
            slug: slugPattern,
            name: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: environmentResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { slug: string; name: string };

      const environment = await createEnvironment(projectDeps, {
        role: actor.role,
        projectId: id,
        slug: body.slug,
        name: body.name,
        operationId: request.id,
        actorId: actor.credentialId,
        sourceIp: request.ip,
      });

      return { data: serializeEnvironment(environment) };
    },
  );

  app.get(
    '/v1/environments/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: environmentIdParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: environmentResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const environment = await getEnvironment(projectDeps, {
        role: actor.role,
        credentialId: actor.credentialId,
        environmentId: id,
      });

      return { data: serializeEnvironment(environment) };
    },
  );

  app.patch(
    '/v1/environments/:id',
    {
      preHandler: app.authenticate,
      schema: {
        params: environmentIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['data'],
            properties: { data: environmentResponseSchema },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = request.body as { enabled: boolean };

      const environment = await setEnvironmentEnabled(projectDeps, {
        role: actor.role,
        environmentId: id,
        enabled: body.enabled,
        operationId: request.id,
        actorId: actor.credentialId,
        sourceIp: request.ip,
      });

      return { data: serializeEnvironment(environment) };
    },
  );
}
