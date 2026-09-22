import type { AppInstance } from '../types.js';
import { changePassword } from '../../app/auth/change-password.js';
import { login } from '../../app/auth/login.js';
import { logout } from '../../app/auth/logout.js';
import { permissionsForActor } from '../../domain/auth/roles.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { clearSessionCookie, serializeSessionCookie } from '../cookies.js';
import { requireActor } from '../plugins/authentication.js';

const DASHBOARD_ROLES = ['admin', 'operator', 'viewer'] as const;

export function registerAuthRoutes(app: AppInstance, container: Container): void {
  const security = requireApiSecurity(container);

  app.post(
    '/v1/auth/login',
    {
      config: {
        rateLimit: {
          max: security.loginRateLimitMax,
          timeWindow: security.loginRateLimitWindowSeconds * 1000,
          keyGenerator: (request) => `login:${request.ip}`,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 1, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const result = await login(
        {
          users: requireDashboardUsers(container),
          operatorMutations: container.operatorMutations,
        },
        {
          email: body.email,
          password: body.password,
          now: container.clock.now(),
          absoluteTtlSeconds: security.sessionAbsoluteTtlSeconds,
        },
      );

      void reply.header(
        'set-cookie',
        serializeSessionCookie(result.token, {
          maxAgeSeconds: security.sessionIdleTtlSeconds,
          secure: container.config.app.isHosted,
        }),
      );
      return reply.code(204).send();
    },
  );

  app.post('/v1/auth/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.sessionId !== undefined) {
      await logout(
        { sessions: requireDashboardSessions(container) },
        { sessionId: actor.sessionId, now: container.clock.now() },
      );
    }
    void reply.header('set-cookie', clearSessionCookie(container.config.app.isHosted));
    return reply.code(204).send();
  });

  app.get(
    '/v1/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['user', 'permissions'],
            properties: {
              user: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'email', 'displayName', 'role'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string' },
                  displayName: { type: 'string' },
                  role: { type: 'string', enum: [...DASHBOARD_ROLES] },
                },
              },
              permissions: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      if (
        actor.kind !== 'dashboard_user' ||
        actor.userId === undefined ||
        actor.dashboardRole === undefined
      ) {
        throw new ChainBankError('INSUFFICIENT_ROLE', 'Session profile requires a dashboard user', {
          publicMessage: 'Sign in with a dashboard account.',
        });
      }
      const user = await requireDashboardUsers(container).findById(actor.userId);
      if (user === undefined || !user.enabled) {
        throw new ChainBankError('INVALID_CREDENTIAL', 'Dashboard user is missing or disabled', {
          publicMessage: 'The supplied credential is not valid.',
        });
      }
      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
        },
        permissions: [...permissionsForActor(actor)],
      };
    },
  );

  app.post(
    '/v1/auth/password',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
            newPassword: { type: 'string', minLength: 12, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = request.body as { currentPassword: string; newPassword: string };
      await changePassword(
        {
          users: requireDashboardUsers(container),
          operatorMutations: container.operatorMutations,
        },
        {
          actor,
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
          now: container.clock.now(),
          operationId: request.id,
          sourceIp: request.ip,
        },
      );
      return reply.code(204).send();
    },
  );
}

function requireApiSecurity(container: Container): NonNullable<Container['config']['apiSecurity']> {
  const security = container.config.apiSecurity;
  if (security === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'API security configuration is required for auth routes',
      {
        publicMessage: 'The service is misconfigured.',
      },
    );
  }
  return security;
}

export function requireDashboardUsers(
  container: Container,
): NonNullable<Container['repositories']['dashboardUsers']> {
  const users = container.repositories.dashboardUsers;
  if (users === undefined) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'Dashboard user repository is not configured', {
      publicMessage: 'The service is misconfigured.',
    });
  }
  return users;
}

export function requireDashboardSessions(
  container: Container,
): NonNullable<Container['repositories']['dashboardSessions']> {
  const sessions = container.repositories.dashboardSessions;
  if (sessions === undefined) {
    throw new ChainBankError('INVALID_CONFIGURATION', 'Dashboard session repository is not configured', {
      publicMessage: 'The service is misconfigured.',
    });
  }
  return sessions;
}
