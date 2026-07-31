import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { authenticateCredential } from '../../src/app/auth/authenticate-credential.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import {
  apiCredentialScopes,
  apiCredentials,
  auditEvents,
  type AuditEventRow,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';
import { validWebEnv } from '../support/env.js';
import type { AppInstance } from '../../src/api/types.js';

describe.skipIf(!integrationEnabled)('admin credential lifecycle (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let operatorCredentialId: string;
  let targetToken: string;
  let targetCredentialId: string;
  let seed: Phase1Seed;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    const operatorGenerated = generateApiToken();
    operatorToken = operatorGenerated.token;
    const [operatorRow] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: operatorGenerated.tokenHash,
        tokenPrefix: operatorGenerated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (operatorRow === undefined) {
      throw new Error('Failed to seed operator credential');
    }
    operatorCredentialId = operatorRow.id;

    const targetGenerated = generateApiToken();
    targetToken = targetGenerated.token;
    const [targetRow] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `project-service-${randomUUID()}`,
        role: 'project-service',
        tokenHash: targetGenerated.tokenHash,
        tokenPrefix: targetGenerated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (targetRow === undefined) {
      throw new Error('Failed to seed target credential');
    }
    targetCredentialId = targetRow.id;

    await handle.db.insert(apiCredentialScopes).values({
      credentialId: targetCredentialId,
      projectId: seed.projectId,
    });

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    });
    const clock = createFixedClock();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    container = {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database: {
        db: handle.db,
        pool: handle.pool,
        close: () => Promise.resolve(),
      },
      repositories: {
        chains: {} as Container['repositories']['chains'],
        treasuries: {} as Container['repositories']['treasuries'],
        balanceObservations: {} as Container['repositories']['balanceObservations'],
        apiCredentials: createApiCredentialRepository(handle.db),
        auditEvents: createAuditEventRepository(handle.db),
        serviceHeartbeats: {} as Container['repositories']['serviceHeartbeats'],
        managedWallets: {} as Container['repositories']['managedWallets'],
        fundingPolicies: {} as Container['repositories']['fundingPolicies'],
        projects: {} as Container['repositories']['projects'],
        environments: {} as Container['repositories']['environments'],
        credentialScopes: {} as Container['repositories']['credentialScopes'],
        fundingOperations: {} as Container['repositories']['fundingOperations'],
        fundingTransactions: {} as Container['repositories']['fundingTransactions'],
        alerts: {} as Container['repositories']['alerts'],
      },
      balanceReader: {} as Container['balanceReader'],
      treasurySigner: undefined,
      fundingDispatchLock: {} as Container['fundingDispatchLock'],
      transactionReceiptTracker: {} as Container['transactionReceiptTracker'],
      emailSender: undefined,
      close: () => Promise.resolve(),
    };

    if (app !== undefined) {
      await app.close();
    }
    app = await buildApp(container);
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    await handle.close();
  });

  it('issues → lists → disables → refuses authentication and records audit', async () => {
    const listBeforeAuth = await authenticateCredential(
      { apiCredentials: container.repositories.apiCredentials, clock: container.clock },
      targetToken,
    );
    expect(listBeforeAuth.credentialId).toBe(targetCredentialId);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/admin/credentials',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(listResponse.statusCode).toBe(200);
    const listJson = listResponse.json<{ data: readonly Record<string, unknown>[] }>();
    expect(JSON.stringify(listJson)).not.toContain('token_hash');
    expect(JSON.stringify(listJson)).not.toContain('tokenHash');
    const listed = listJson.data.find((row) => row.id === targetCredentialId);
    expect(listed).toMatchObject({
      id: targetCredentialId,
      enabled: true,
      revokedAt: null,
      tokenPrefix: expect.stringMatching(/^cb_/) as unknown,
    });

    // Regression: pagination params must survive schema validation. The app
    // runs ajv with coerceTypes:false, so a `type: 'integer'` query schema
    // rejected every request that supplied limit/offset. The list call above
    // passes no query string, which is why the defect shipped.
    const paginatedResponse = await app.inject({
      method: 'GET',
      url: '/v1/admin/credentials?limit=50&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(paginatedResponse.statusCode).toBe(200);
    expect(
      paginatedResponse.json<{ pagination: { limit: number; offset: number } }>().pagination,
    ).toMatchObject({ limit: 50, offset: 0 });

    const rejectedPagination = await app.inject({
      method: 'GET',
      url: '/v1/admin/credentials?limit=abc',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(rejectedPagination.statusCode).toBe(400);

    const disableResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/credentials/${targetCredentialId}`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'disable' },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      data: { id: targetCredentialId, enabled: false, revokedAt: null },
    });

    await expect(
      authenticateCredential(
        { apiCredentials: container.repositories.apiCredentials, clock: container.clock },
        targetToken,
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DISABLED' });

    const scopeRows = await handle.db.query.apiCredentialScopes.findMany({
      where: eq(apiCredentialScopes.credentialId, targetCredentialId),
    });
    expect(scopeRows).toHaveLength(1);

    const auditRows: readonly AuditEventRow[] = await handle.db.query.auditEvents.findMany({
      where: eq(auditEvents.entityId, targetCredentialId),
    });
    expect(auditRows.some((row) => row.action === 'credential.disabled')).toBe(true);
    expect(auditRows.some((row) => row.actorId === operatorCredentialId)).toBe(true);
  });

  it('revoke sets revoked_at and writes credential.revoked audit event', async () => {
    const revokeResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/credentials/${targetCredentialId}`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'revoke' },
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json<{ data: { revokedAt: string | null } }>().data.revokedAt).not.toBeNull();

    const auditRows: readonly AuditEventRow[] = await handle.db.query.auditEvents.findMany({
      where: eq(auditEvents.entityId, targetCredentialId),
    });
    expect(auditRows.some((row) => row.action === 'credential.revoked')).toBe(true);
  });
});
