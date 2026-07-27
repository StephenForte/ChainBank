import type { AppInstance } from '../types.js';
import { checkReadiness } from '../../app/health/check-readiness.js';
import type { Container } from '../../container.js';

/**
 * Health endpoints are the only unauthenticated routes in the service.
 *
 * They expose component status and heartbeat timestamps, which a platform load
 * balancer needs, and nothing about balances, addresses, or configuration.
 */
export function registerHealthRoutes(app: AppInstance, container: Container): void {
  app.get(
    '/health/live',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'service'],
            properties: {
              status: { type: 'string' },
              service: { type: 'string' },
            },
          },
        },
      },
    },
    () => ({ status: 'live', service: container.config.app.serviceRole }),
  );

  app.get('/health/ready', async (_request, reply) => {
    const result = await checkReadiness({
      serviceHeartbeats: container.repositories.serviceHeartbeats,
      balanceReader: container.balanceReader,
      clock: container.clock,
    });

    // A degraded RPC endpoint still serves traffic correctly, so only a
    // database failure removes the instance from rotation.
    const statusCode = result.status === 'failed' ? 503 : 200;

    return reply.status(statusCode).send({
      status: result.status,
      checkedAt: result.checkedAt.toISOString(),
      components: result.components.map((component) => ({
        name: component.name,
        status: component.status,
        detail: component.detail ?? null,
      })),
      heartbeats: result.heartbeats.map((heartbeat) => ({
        serviceRole: heartbeat.serviceRole,
        lastSeenAt: heartbeat.lastSeenAt.toISOString(),
      })),
    });
  });
}
