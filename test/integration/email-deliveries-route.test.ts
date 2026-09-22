import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import { hashPassword } from '../../src/domain/auth/password.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createDashboardSessionRepository } from '../../src/infrastructure/db/repositories/dashboard-session-repository.js';
import { createDashboardUserRepository } from '../../src/infrastructure/db/repositories/dashboard-user-repository.js';
import { createEmailDeliveryRepository } from '../../src/infrastructure/db/repositories/email-delivery-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentialScopes,
  apiCredentials,
  dashboardUsers,
  emailDeliveries,
} from '../../src/infrastructure/db/schema.js';
import { createLogOnlyEmailSender } from '../../src/infrastructure/email/log-only-email-sender.js';
import { createRecordingEmailSender } from '../../src/infrastructure/email/recording-email-sender.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import { emptyChainAdapterRegistry } from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const PASSWORD = 'correct-horse-battery';
const SESSION_HEADER = { 'x-chainbank-session': '1' };
const SENT_AT = new Date('2026-09-22T12:00:00.000Z');

describe.skipIf(!integrationEnabled)('email deliveries and triggers (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let operatorToken: string;
  let readOnlyToken: string;
  let projectServiceToken: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    const operator = generateApiToken();
    operatorToken = operator.token;
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: operator.tokenHash,
      tokenPrefix: operator.tokenPrefix,
    });

    const readOnly = generateApiToken();
    readOnlyToken = readOnly.token;
    await handle.db.insert(apiCredentials).values({
      name: `readonly-${randomUUID()}`,
      role: 'read-only',
      tokenHash: readOnly.tokenHash,
      tokenPrefix: readOnly.tokenPrefix,
    });

    const projectService = generateApiToken();
    projectServiceToken = projectService.token;
    const [credential] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `project-service-${randomUUID()}`,
        role: 'project-service',
        tokenHash: projectService.tokenHash,
        tokenPrefix: projectService.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (credential === undefined) {
      throw new Error('Failed to seed project-service credential');
    }
    await handle.db.insert(apiCredentialScopes).values({
      credentialId: credential.id,
      projectId: seed.projectId,
      environmentId: null,
    });

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ DATABASE_URL: process.env.DATABASE_URL }),
    });
    const clock = createFixedClock(SENT_AT);
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const emailDeliveriesRepo = createEmailDeliveryRepository(handle.db);
    const container: Container = {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database: { db: handle.db, pool: handle.pool, close: () => Promise.resolve() },
      repositories: {
        chains: {} as Container['repositories']['chains'],
        treasuries: createTreasuryRepository(handle.db),
        balanceObservations: {} as Container['repositories']['balanceObservations'],
        apiCredentials: createApiCredentialRepository(handle.db),
        auditEvents: createAuditEventRepository(handle.db),
        serviceHeartbeats: {} as Container['repositories']['serviceHeartbeats'],
        managedWallets: {} as Container['repositories']['managedWallets'],
        fundingPolicies: {} as Container['repositories']['fundingPolicies'],
        projects: {} as Container['repositories']['projects'],
        environments: {} as Container['repositories']['environments'],
        credentialScopes: createCredentialScopeRepository(handle.db),
        fundingOperations: {} as Container['repositories']['fundingOperations'],
        fundingTransactions: {} as Container['repositories']['fundingTransactions'],
        alerts: {} as Container['repositories']['alerts'],
        reconciliationRuns: {} as Container['repositories']['reconciliationRuns'],
        reconciliationFunding: {} as Container['repositories']['reconciliationFunding'],
        fundingHealth: {} as Container['repositories']['fundingHealth'],
        dashboardUsers: createDashboardUserRepository(handle.db),
        dashboardSessions: createDashboardSessionRepository(handle.db),
        emailDeliveries: emailDeliveriesRepo,
      },
      chainAdapters: emptyChainAdapterRegistry(),
      fundingDispatchLock: {} as Container['fundingDispatchLock'],
      operatorMutations: createOperatorMutationTransaction(handle.db),
      emailSender: createRecordingEmailSender({
        inner: createLogOnlyEmailSender(logger),
        deliveries: emailDeliveriesRepo,
        logger,
        clock,
        serviceRole: 'web',
      }),
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

  it('records one log-only test email and lists it, hiding failed rows from that filter', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: '/v1/admin/email/test',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {},
    });
    expect(sent.statusCode).toBe(200);

    const stored = await handle.db.select().from(emailDeliveries);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'test_email',
      status: 'sent',
      recipients: ['operator@example.com'],
      serviceRole: 'web',
      providerMessageId: null,
      errorCode: null,
      errorSummary: null,
      sentAt: SENT_AT,
    });
    expect(stored[0]?.subject).toContain('test message');

    const columns = await handle.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_deliveries'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain('text');
    expect(names).not.toContain('html');
    expect(names).not.toContain('body');

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/admin/email/deliveries',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{
      data: Array<{ kind: string; status: string; recipients: string[] }>;
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      kind: 'test_email',
      status: 'sent',
      recipients: ['operator@example.com'],
    });
    expect(body.data[0]).not.toHaveProperty('text');
    expect(body.data[0]).not.toHaveProperty('html');

    const failed = await app.inject({
      method: 'GET',
      url: '/v1/admin/email/deliveries?status=failed',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json<{ data: unknown[]; pagination: { total: number } }>()).toEqual({
      data: [],
      pagination: { limit: 50, offset: 0, total: 0 },
    });
  });

  it('lets a viewer cookie and a read-only bearer read both routes, and denies project-service', async () => {
    await insertViewer();
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'viewer@example.com', password: PASSWORD },
    });
    expect(loggedIn.statusCode).toBe(204);
    const viewerHeaders = {
      cookie: `chainbank_session=${sessionToken(loggedIn)}`,
      ...SESSION_HEADER,
    };

    for (const headers of [viewerHeaders, { authorization: `Bearer ${readOnlyToken}` }]) {
      const deliveries = await app.inject({
        method: 'GET',
        url: '/v1/admin/email/deliveries',
        headers,
      });
      expect(deliveries.statusCode).toBe(200);

      const triggers = await app.inject({
        method: 'GET',
        url: '/v1/admin/email/triggers',
        headers,
      });
      expect(triggers.statusCode).toBe(200);
      const view = triggers.json<{
        data: {
          provider: string;
          fromAddress: string;
          recipients: string[];
          triggers: Array<{ scope: string }>;
        };
      }>();
      expect(view.data.provider).toBe('log-only');
      expect(view.data.fromAddress).toBe('chainbank@example.com');
      expect(view.data.recipients).toEqual(['operator@example.com']);
      expect(
        view.data.triggers.some((row) => row.scope.includes('0x1111111111111111111111111111111111111111')),
      ).toBe(true);
      expect(view.data.triggers.some((row) => row.scope.includes('Public'))).toBe(true);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('re_');
    }

    for (const url of ['/v1/admin/email/deliveries', '/v1/admin/email/triggers']) {
      const denied = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${projectServiceToken}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_ROLE');
    }
  });

  async function insertViewer(): Promise<void> {
    const password = await hashPassword(PASSWORD);
    await handle.db.insert(dashboardUsers).values({
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'viewer',
      passwordHash: password.passwordHash,
      passwordParams: password.passwordParams,
    });
  }
});

function sessionToken(response: {
  headers: { readonly 'set-cookie'?: string | readonly string[] | undefined };
}): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw.join(';') : String(raw ?? '');
  const match = /chainbank_session=([^;]+)/.exec(header);
  const token = match?.[1];
  if (token === undefined || token === '') {
    throw new Error(`session cookie missing from ${header}`);
  }
  return token;
}
