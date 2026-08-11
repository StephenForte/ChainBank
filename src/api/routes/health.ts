import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../types.js';
import { checkFundingHealth } from '../../app/health/check-funding-health.js';
import { checkReadiness } from '../../app/health/check-readiness.js';
import { extractBearerToken } from '../../app/auth/authenticate-credential.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Container } from '../../container.js';

/**
 * Liveness and readiness stay unauthenticated (load balancers).
 *
 * GET /health/funding is token-gated: on-chain balances are public, but an
 * unauthenticated inventory of which wallets this service funds and their
 * policy floors is gratuitous disclosure.
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

  app.get('/health/funding', async (request, reply) => {
    assertFundingHealthToken(request, container.config.apiSecurity?.fundingHealthToken);

    const result = await checkFundingHealth({
      reconciliationRuns: container.repositories.reconciliationRuns,
      managedWallets: container.repositories.managedWallets,
      fundingHealth: container.repositories.fundingHealth,
      balanceReader: container.balanceReader,
      clock: container.clock,
    });

    // Always HTTP 200 when the check itself succeeds — consumers read `status`.
    return reply.status(200).send({
      status: result.status,
      checkedAt: result.checkedAt.toISOString(),
      lastRun:
        result.lastRun === undefined
          ? null
          : {
              runId: result.lastRun.runId,
              finishedAt: result.lastRun.finishedAt,
              exitKind: result.lastRun.exitKind,
              ageSeconds: result.lastRun.ageSeconds,
            },
      wallets: result.wallets.map((wallet) => ({
        label: wallet.label,
        address: wallet.address,
        chainId: wallet.chainId,
        balanceWei: wallet.balanceWei,
        policyMinWei: wallet.policyMinWei,
        lastFundedAt: wallet.lastFundedAt ?? null,
        lastFundedWei: wallet.lastFundedWei ?? null,
        lastFundedTxHash: wallet.lastFundedTxHash ?? null,
        status: wallet.status,
      })),
    });
  });
}

/**
 * Compares the presented bearer token to FUNDING_HEALTH_TOKEN.
 *
 * Fail closed when the token is unset or mismatched. Uses a length-normalized
 * timing-safe compare so absence and wrong-token take the same public path.
 */
export function assertFundingHealthToken(request: FastifyRequest, expectedToken: string | undefined): void {
  const presented = extractBearerToken(request.headers.authorization);
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new ChainBankError(
      'AUTHENTICATION_REQUIRED',
      'FUNDING_HEALTH_TOKEN is not configured; refusing funding health',
      { publicMessage: 'A bearer token is required.' },
    );
  }
  if (!secureTokenEquals(presented, expectedToken)) {
    throw new ChainBankError('INVALID_CREDENTIAL', 'Funding health token mismatch', {
      publicMessage: 'The supplied credential is not valid.',
    });
  }
}

function secureTokenEquals(presented: string, expected: string): boolean {
  const presentedBuffer = Buffer.from(presented);
  const expectedBuffer = Buffer.from(expected);
  if (presentedBuffer.length !== expectedBuffer.length) {
    // Compare against self so the failure path still does a constant-time op
    // of similar cost without throwing from timingSafeEqual on length mismatch.
    timingSafeEqual(presentedBuffer, presentedBuffer);
    return false;
  }
  return timingSafeEqual(presentedBuffer, expectedBuffer);
}
