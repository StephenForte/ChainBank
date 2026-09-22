import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import { hashPassword } from '../../src/domain/auth/password.js';
import { hashSessionToken } from '../../src/domain/auth/session-token.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createDashboardSessionRepository } from '../../src/infrastructure/db/repositories/dashboard-session-repository.js';
import { createDashboardUserRepository } from '../../src/infrastructure/db/repositories/dashboard-user-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentials,
  auditEvents,
  dashboardSessions,
  dashboardUsers,
} from '../../src/infrastructure/db/schema.js';
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
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const PASSWORD = 'correct-horse-battery';
const SESSION_HEADER = { 'x-chainbank-session': '1' };

describe.skipIf(!integrationEnabled)('dashboard users and sessions (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let app: AppInstance;
  let container: Container;
  let operatorToken: string;
  let clock: ReturnType<typeof createFixedClock>;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    await seedPhase1Fixtures(handle.db);

    const operatorGenerated = generateApiToken();
    operatorToken = operatorGenerated.token;
    await handle.db.insert(apiCredentials).values({
      name: `operator-${randomUUID()}`,
      role: 'operator',
      tokenHash: operatorGenerated.tokenHash,
      tokenPrefix: operatorGenerated.tokenPrefix,
    });

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ DATABASE_URL: process.env.DATABASE_URL }),
    });
    clock = createFixedClock();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    container = {
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
        credentialScopes: {} as Container['repositories']['credentialScopes'],
        fundingOperations: {} as Container['repositories']['fundingOperations'],
        fundingTransactions: {} as Container['repositories']['fundingTransactions'],
        alerts: {} as Container['repositories']['alerts'],
        reconciliationRuns: {} as Container['repositories']['reconciliationRuns'],
        reconciliationFunding: {} as Container['repositories']['reconciliationFunding'],
        fundingHealth: {} as Container['repositories']['fundingHealth'],
        dashboardUsers: createDashboardUserRepository(handle.db),
        dashboardSessions: createDashboardSessionRepository(handle.db),
      },
      chainAdapters: emptyChainAdapterRegistry(),
      fundingDispatchLock: {} as Container['fundingDispatchLock'],
      operatorMutations: createOperatorMutationTransaction(handle.db),
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

  it('stores only hashes and rejects unknown, wrong, and disabled with the same error', async () => {
    const admin = await insertUser('admin@example.com', 'Ada', 'admin');
    const ok = await login('admin@example.com', PASSWORD);
    expect(ok.statusCode).toBe(204);
    const token = sessionToken(ok);
    expect(ok.headers['set-cookie']).toContain('HttpOnly');
    expect(ok.headers['set-cookie']).toContain('SameSite=Strict');
    expect(String(ok.headers['set-cookie'])).not.toContain('Secure');

    const [userRow] = await handle.db.select().from(dashboardUsers).where(eq(dashboardUsers.id, admin.id));
    const [sessionRow] = await handle.db
      .select()
      .from(dashboardSessions)
      .where(eq(dashboardSessions.tokenHash, hashSessionToken(token)));
    expect(userRow?.passwordHash).not.toBe(PASSWORD);
    expect(userRow?.passwordHash.includes(PASSWORD)).toBe(false);
    expect(JSON.stringify(userRow?.passwordParams).includes(PASSWORD)).toBe(false);
    expect(sessionRow?.tokenHash).toBe(hashSessionToken(token));
    expect(sessionRow?.tokenHash).not.toContain(token);

    const unknown = await login('missing@example.com', PASSWORD);
    const wrong = await login('admin@example.com', `${PASSWORD}-nope`);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(errorBody(unknown)).toEqual(errorBody(wrong));

    await handle.db.update(dashboardUsers).set({ enabled: false }).where(eq(dashboardUsers.id, admin.id));
    const disabled = await login('admin@example.com', PASSWORD);
    expect(disabled.statusCode).toBe(401);
    expect(errorBody(disabled)).toEqual(errorBody(wrong));
  });

  it('accepts a cookie only with the session header, and never as a fallback for a bearer header', async () => {
    await insertUser('admin@example.com', 'Ada', 'admin');
    const loggedIn = await login('admin@example.com', PASSWORD);
    const token = sessionToken(loggedIn);

    const noHeader = await app.inject({
      method: 'GET',
      url: '/v1/treasuries',
      headers: { cookie: `chainbank_session=${token}` },
    });
    expect(noHeader.statusCode).toBe(401);

    const withHeader = await app.inject({
      method: 'GET',
      url: '/v1/treasuries',
      headers: { cookie: `chainbank_session=${token}`, ...SESSION_HEADER },
    });
    expect(withHeader.statusCode).toBe(200);

    const bearer = await app.inject({
      method: 'GET',
      url: '/v1/treasuries',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(bearer.statusCode).toBe(200);

    const both = await app.inject({
      method: 'GET',
      url: '/v1/treasuries',
      headers: {
        authorization: 'Bearer not-a-valid-token',
        cookie: `chainbank_session=${token}`,
        ...SESSION_HEADER,
      },
    });
    expect(both.statusCode).toBe(401);
  });

  it('rejects an expired session without sliding it, and logout revokes', async () => {
    const admin = await insertUser('admin@example.com', 'Ada', 'admin');
    const now = clock.now();
    const expiredHash = hashSessionToken('expired-session-token');
    await handle.db.insert(dashboardSessions).values({
      userId: admin.id,
      tokenHash: expiredHash,
      createdAt: new Date(now.getTime() - 86_400_000),
      expiresAt: new Date(now.getTime() - 1000),
      lastSeenAt: new Date(now.getTime() - 1000),
    });

    const expired = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'chainbank_session=expired-session-token', ...SESSION_HEADER },
    });
    expect(expired.statusCode).toBe(401);
    const [expiredRow] = await handle.db
      .select()
      .from(dashboardSessions)
      .where(eq(dashboardSessions.tokenHash, expiredHash));
    expect(expiredRow?.lastSeenAt.toISOString()).toBe(new Date(now.getTime() - 1000).toISOString());
    expect(expiredRow?.revokedAt).toBeNull();

    const loggedIn = await login('admin@example.com', PASSWORD);
    const token = sessionToken(loggedIn);
    const goodbye = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `chainbank_session=${token}`, ...SESSION_HEADER },
    });
    expect(goodbye.statusCode).toBe(204);
    expect(String(goodbye.headers['set-cookie'])).toContain('Max-Age=0');

    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `chainbank_session=${token}`, ...SESSION_HEADER },
    });
    expect(after.statusCode).toBe(401);
    const [revoked] = await handle.db
      .select()
      .from(dashboardSessions)
      .where(eq(dashboardSessions.tokenHash, hashSessionToken(token)));
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });

  it('lets an admin manage users, forbids a viewer and self-demotion, and audits as dashboard_user', async () => {
    await insertUser('admin@example.com', 'Ada', 'admin');
    const adminLogin = await login('admin@example.com', PASSWORD);
    const adminCookie = { cookie: `chainbank_session=${sessionToken(adminLogin)}`, ...SESSION_HEADER };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: adminCookie,
      payload: {
        email: 'viewer@example.com',
        displayName: 'Vera',
        role: 'viewer',
        password: PASSWORD,
      },
    });
    expect(created.statusCode).toBe(200);
    const viewerId = created.json<{ data: { id: string } }>().data.id;

    const viewerLogin = await login('viewer@example.com', PASSWORD);
    const viewerDenied = await app.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: { cookie: `chainbank_session=${sessionToken(viewerLogin)}`, ...SESSION_HEADER },
    });
    expect(viewerDenied.statusCode).toBe(403);

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: adminCookie });
    expect(me.statusCode).toBe(200);
    const adminId = me.json<{ user: { id: string }; permissions: string[] }>().user.id;
    expect(me.json<{ permissions: string[] }>().permissions).toContain('user:manage');

    const selfDisable = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${adminId}`,
      headers: adminCookie,
      payload: { enabled: false },
    });
    expect(selfDisable.statusCode).toBe(400);
    expect(selfDisable.json<{ error: { code: string } }>().error.code).toBe(
      'CREDENTIAL_SELF_MUTATION_DENIED',
    );

    const other = await login('admin@example.com', PASSWORD);
    const otherCookie = { cookie: `chainbank_session=${sessionToken(other)}`, ...SESSION_HEADER };
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: adminCookie,
      payload: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-rotated` },
    });
    expect(changed.statusCode).toBe(204);

    const otherAfter = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: otherCookie });
    expect(otherAfter.statusCode).toBe(401);
    const still = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: adminCookie });
    expect(still.statusCode).toBe(200);

    const audits = await handle.db.select().from(auditEvents);
    const actions = audits.map((row) => row.action);
    expect(actions).toContain('user.created');
    expect(actions).toContain('user.password_changed');
    for (const row of audits) {
      expect(row.actorType).toBe('dashboard_user');
      expect(JSON.stringify(row.metadata)).not.toContain(PASSWORD);
    }
    expect(audits.find((row) => row.entityId === viewerId)?.actorType).toBe('dashboard_user');
  });

  it('rate-limits login per IP more tightly than the global limit', async () => {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login('nobody@example.com', 'wrong-password-value');
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(401);
    const blocked = await login('nobody@example.com', 'wrong-password-value');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
  });

  it('revokes every session when an admin sets another user password', async () => {
    await insertUser('admin@example.com', 'Ada', 'admin');
    const adminLogin = await login('admin@example.com', PASSWORD);
    const adminCookie = { cookie: `chainbank_session=${sessionToken(adminLogin)}`, ...SESSION_HEADER };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: adminCookie,
      payload: {
        email: 'operator@example.com',
        displayName: 'Otto',
        role: 'operator',
        password: PASSWORD,
      },
    });
    expect(created.statusCode).toBe(200);
    const operatorId = created.json<{ data: { id: string } }>().data.id;

    const operatorLogin = await login('operator@example.com', PASSWORD);
    const operatorCookie = {
      cookie: `chainbank_session=${sessionToken(operatorLogin)}`,
      ...SESSION_HEADER,
    };
    const before = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: operatorCookie });
    expect(before.statusCode).toBe(200);

    const reset = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${operatorId}`,
      headers: adminCookie,
      payload: { password: `${PASSWORD}-reset-by-admin` },
    });
    expect(reset.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: operatorCookie });
    expect(after.statusCode).toBe(401);
    const adminStill = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: adminCookie });
    expect(adminStill.statusCode).toBe(200);
  });

  it('logs in, reads me and treasuries with the cookie and session header, then logout rejects that cookie', async () => {
    await insertUser('admin@example.com', 'Ada', 'admin');
    const loggedIn = await login('admin@example.com', PASSWORD);
    expect(loggedIn.statusCode).toBe(204);
    const token = sessionToken(loggedIn);
    const headers = { cookie: `chainbank_session=${token}`, ...SESSION_HEADER };

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    expect(me.statusCode).toBe(200);

    const treasuries = await app.inject({ method: 'GET', url: '/v1/treasuries', headers });
    expect(treasuries.statusCode).toBe(200);

    const loggedOut = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
    expect(loggedOut.statusCode).toBe(204);

    const again = await app.inject({ method: 'GET', url: '/v1/treasuries', headers });
    expect(again.statusCode).toBe(401);
  });

  async function insertUser(
    email: string,
    displayName: string,
    role: 'admin' | 'operator' | 'viewer',
  ): Promise<{ id: string }> {
    const password = await hashPassword(PASSWORD);
    const [row] = await handle.db
      .insert(dashboardUsers)
      .values({
        email,
        displayName,
        role,
        passwordHash: password.passwordHash,
        passwordParams: password.passwordParams,
      })
      .returning({ id: dashboardUsers.id });
    if (row === undefined) {
      throw new Error('failed to insert dashboard user');
    }
    return row;
  }

  function login(email: string, password: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
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

function errorBody(response: { json: () => unknown }): { code: string; message: string } {
  const body = response.json() as { error: { code: string; message: string } };
  return { code: body.error.code, message: body.error.message };
}
