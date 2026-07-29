import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedActor } from '../../../src/app/auth/authenticate-credential.js';
import { getOperationStatus } from '../../../src/app/funding/get-operation-status.js';
import type { CredentialScope } from '../../../src/app/ports.js';
import { registerErrorHandler } from '../../../src/api/plugins/error-handler.js';
import { requireActor } from '../../../src/api/plugins/authentication.js';
import { serializeFundingOperation } from '../../../src/api/serializers/funding-operation.js';
import type { AppInstance } from '../../../src/api/types.js';
import { createLogger } from '../../../src/observability/logger.js';
import { createFixedClock } from '../../support/clock.js';
import { createFakeReceiptTracker, createInMemoryFundingStores } from '../../support/funding-fakes.js';

const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const EXPLORER = 'https://sepolia.etherscan.io';
const SENDER = `0x${'11'.repeat(20)}`;

/**
 * Lightweight route harness for GET /v1/funding-operations/:id.
 *
 * Uses the real application service + error handler so HTTP status codes match
 * production, without requiring a full Container / database.
 */
async function buildRouteApp(options: {
  readonly actor: AuthenticatedActor;
  readonly stores: ReturnType<typeof createInMemoryFundingStores>;
  readonly clock: ReturnType<typeof createFixedClock>;
  readonly scopes?: readonly CredentialScope[];
}): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    requestIdHeader: false,
    genReqId: () => 'req-test-1',
  }) as AppInstance;

  registerErrorHandler(app);

  app.get(
    '/v1/funding-operations/:id',
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
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const result = await getOperationStatus(
        {
          operations: options.stores.operations,
          transactions: options.stores.transactions,
          receiptTracker: createFakeReceiptTracker({ kind: 'pending' }),
          credentialScopes: {
            listByCredentialId: vi.fn(() => Promise.resolve(options.scopes ?? [])),
            insert: vi.fn(),
          },
          clock: options.clock,
          logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
          confirmations: 1,
          confirmationTimeoutMs: 60_000,
          treasuryAddress: SENDER,
        },
        {
          operationId: id,
          role: actor.role,
          credentialId: actor.credentialId,
          correlationId: request.id,
        },
      );
      return { data: serializeFundingOperation(result, EXPLORER) };
    },
  );

  await app.ready();
  return app;
}

describe('GET /v1/funding-operations/:id route', () => {
  it('returns 404 FUNDING_OPERATION_NOT_FOUND for an unknown id', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    const app = await buildRouteApp({
      actor: { credentialId: CREDENTIAL_ID, name: 'op', role: 'operator' },
      stores,
      clock,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/funding-operations/${OPERATION_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'FUNDING_OPERATION_NOT_FOUND' },
      requestId: 'req-test-1',
    });

    await app.close();
  });

  it('returns 403 SCOPE_DENIED when project-service is outside scope', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    await stores.operations.insertPending({
      id: OPERATION_ID,
      operationType: 'ensure_funded',
      projectId: PROJECT_B,
      environmentId: undefined,
      idempotencyKey: undefined,
      requestedBy: CREDENTIAL_ID,
      startedAt: clock.now(),
    });

    const app = await buildRouteApp({
      actor: { credentialId: CREDENTIAL_ID, name: 'svc', role: 'project-service' },
      stores,
      clock,
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: new Date(),
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/funding-operations/${OPERATION_ID}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'SCOPE_DENIED' },
      requestId: 'req-test-1',
    });

    await app.close();
  });

  it('returns 403 SCOPE_DENIED when project-service reads a null-projectId operation', async () => {
    const stores = createInMemoryFundingStores();
    const clock = createFixedClock();
    await stores.operations.insertPending({
      id: OPERATION_ID,
      operationType: 'ensure_funded',
      projectId: undefined,
      environmentId: undefined,
      idempotencyKey: undefined,
      requestedBy: CREDENTIAL_ID,
      startedAt: clock.now(),
    });

    const app = await buildRouteApp({
      actor: { credentialId: CREDENTIAL_ID, name: 'svc', role: 'project-service' },
      stores,
      clock,
      scopes: [
        {
          id: 'scope-1',
          credentialId: CREDENTIAL_ID,
          projectId: PROJECT_A,
          environmentId: undefined,
          createdAt: new Date(),
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/funding-operations/${OPERATION_ID}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'SCOPE_DENIED' },
    });

    await app.close();
  });
});
