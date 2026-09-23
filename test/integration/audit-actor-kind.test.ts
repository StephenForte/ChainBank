import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { buildApp } from '../../src/api/app.js';
import type { AppInstance } from '../../src/api/types.js';
import {
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
} from '../../src/app/alerts/notify-treasury-finding.js';
import { hashPassword } from '../../src/domain/auth/password.js';
import { loadConfig } from '../../src/config/index.js';
import type { Container } from '../../src/container.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createDashboardSessionRepository } from '../../src/infrastructure/db/repositories/dashboard-session-repository.js';
import { createDashboardUserRepository } from '../../src/infrastructure/db/repositories/dashboard-user-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingHealthQuery } from '../../src/infrastructure/db/repositories/funding-health-query-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createReconciliationFundingQuery } from '../../src/infrastructure/db/repositories/reconciliation-query-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  alerts,
  apiCredentials,
  auditEvents,
  dashboardUsers,
  fundingPolicies,
  managedWallets,
} from '../../src/infrastructure/db/schema.js';
import type { AuditEventRow } from '../../src/infrastructure/db/schema.js';
import { createLogOnlyEmailSender } from '../../src/infrastructure/email/log-only-email-sender.js';
import { buildReconcileWalletsDependencies, runWalletReconciler } from '../../src/jobs/wallet-reconciler.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { validWebEnv } from '../support/env.js';
import {
  createFakeBalanceReader,
  createFakeOutgoingScanner,
  createFakeReceiptTracker,
  createFakeSigner,
  createTestChainAdapterRegistry,
} from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';
import { eq } from 'drizzle-orm';

const PASSWORD = 'correct-horse-battery';
const SESSION_HEADER = { 'x-chainbank-session': '1' };
const CHAIN_ID = 11_155_111;
const ONE_ETH = 10n ** 18n;
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
const SEEDED_WALLET_ADDRESS = '0x2222222222222222222222222222222222222222';
const POLICY = {
  minimumBalanceWei: '100000000000000000',
  targetBalanceWei: '200000000000000000',
  maximumTopUpWei: '200000000000000000',
};

describe.skipIf(!integrationEnabled)('audit rows name the authenticated actor (TX.43)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let operatorToken: string;
  let operatorCredentialId: string;
  let sessionTargetCredentialId: string;
  let bearerTargetCredentialId: string;
  let sessionCookie = '';

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    const operator = generateApiToken();
    operatorToken = operator.token;
    const [operatorRow] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: operator.tokenHash,
        tokenPrefix: operator.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (operatorRow === undefined) {
      throw new Error('Failed to seed operator credential');
    }
    operatorCredentialId = operatorRow.id;

    sessionTargetCredentialId = await insertCredential('tx43-session-target');
    bearerTargetCredentialId = await insertCredential('tx43-bearer-target');

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({ DATABASE_URL: process.env.DATABASE_URL }),
    });
    const clock = createFixedClock(new Date('2026-09-23T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const container: Container = {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database: { db: handle.db, pool: handle.pool, close: () => Promise.resolve() },
      repositories: {
        chains: createChainRepository(handle.db),
        treasuries: createTreasuryRepository(handle.db),
        balanceObservations: createBalanceObservationRepository(handle.db),
        apiCredentials: createApiCredentialRepository(handle.db),
        auditEvents: createAuditEventRepository(handle.db),
        serviceHeartbeats: createServiceHeartbeatRepository(handle.db),
        managedWallets: createManagedWalletRepository(handle.db),
        fundingPolicies: createFundingPolicyRepository(handle.db),
        projects: createProjectRepository(handle.db),
        environments: createEnvironmentRepository(handle.db),
        credentialScopes: createCredentialScopeRepository(handle.db),
        fundingOperations: createFundingOperationRepository(handle.db),
        fundingTransactions: createFundingTransactionRepository(handle.db),
        alerts: createAlertRepository(handle.db),
        reconciliationRuns: createReconciliationRunRepository(handle.db),
        reconciliationFunding: {} as Container['repositories']['reconciliationFunding'],
        fundingHealth: {} as Container['repositories']['fundingHealth'],
        dashboardUsers: createDashboardUserRepository(handle.db),
        dashboardSessions: createDashboardSessionRepository(handle.db),
      },
      chainAdapters: createTestChainAdapterRegistry({
        balanceReader: {
          chainId: CHAIN_ID,
          readBalance: () =>
            Promise.resolve({
              kind: 'observed',
              balanceWei: 0n,
              blockNumber: 1n,
              observedAt: clock.now(),
            }),
          verifyChainId: () => Promise.resolve({ matches: true, observedChainId: CHAIN_ID }),
        },
        signer: createFakeSigner({ address: TREASURY_ADDRESS, chainId: CHAIN_ID }),
      }),
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      operatorMutations: createOperatorMutationTransaction(handle.db),
      emailSender: createLogOnlyEmailSender(logger),
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

  it('attributes each mutating route to the session user or the bearer credential', async () => {
    const userId = await insertAdminAndLogin();
    const sessionHeaders = {
      cookie: `chainbank_session=${sessionCookie}`,
      ...SESSION_HEADER,
      'content-type': 'application/json',
    };
    const bearerHeaders = {
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    };

    const sessionWallet = await asActor(
      sessionHeaders,
      'POST',
      '/v1/wallets',
      {
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        chainId: CHAIN_ID,
        role: 'tx43-session',
        address: '0x3333333333333333333333333333333333333333',
      },
      { type: 'dashboard_user', id: userId },
    );
    const bearerWallet = await asActor(
      bearerHeaders,
      'POST',
      '/v1/wallets',
      {
        projectId: seed.projectId,
        environmentId: seed.environmentId,
        chainId: CHAIN_ID,
        role: 'tx43-bearer',
        address: '0x4444444444444444444444444444444444444444',
      },
      { type: 'api_credential', id: operatorCredentialId },
    );
    expect(sessionWallet.json<{ data: { id: string } }>().data.id).not.toBe(
      bearerWallet.json<{ data: { id: string } }>().data.id,
    );

    await asActor(sessionHeaders, 'PUT', `/v1/wallets/${seed.managedWalletId}/policy`, POLICY, {
      type: 'dashboard_user',
      id: userId,
    });
    await asActor(bearerHeaders, 'PUT', `/v1/wallets/${seed.managedWalletId}/policy`, POLICY, {
      type: 'api_credential',
      id: operatorCredentialId,
    });

    await asActor(
      sessionHeaders,
      'PATCH',
      `/v1/wallets/${seed.managedWalletId}`,
      { reconciliationEnabled: true },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'PATCH',
      `/v1/wallets/${seed.managedWalletId}`,
      { reconciliationEnabled: false },
      { type: 'api_credential', id: operatorCredentialId },
    );

    const sessionProject = await asActor(
      sessionHeaders,
      'POST',
      '/v1/projects',
      { slug: 'tx43-session', name: 'TX.43 session' },
      { type: 'dashboard_user', id: userId },
    );
    const bearerProject = await asActor(
      bearerHeaders,
      'POST',
      '/v1/projects',
      { slug: 'tx43-bearer', name: 'TX.43 bearer' },
      { type: 'api_credential', id: operatorCredentialId },
    );
    const sessionProjectId = sessionProject.json<{ data: { id: string } }>().data.id;
    const bearerProjectId = bearerProject.json<{ data: { id: string } }>().data.id;

    await asActor(
      sessionHeaders,
      'PATCH',
      `/v1/projects/${sessionProjectId}`,
      { enabled: false },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'PATCH',
      `/v1/projects/${bearerProjectId}`,
      { enabled: false },
      { type: 'api_credential', id: operatorCredentialId },
    );

    const sessionEnvironment = await asActor(
      sessionHeaders,
      'POST',
      `/v1/projects/${seed.projectId}/environments`,
      { slug: 'tx43-session', name: 'TX.43 session' },
      { type: 'dashboard_user', id: userId },
    );
    const bearerEnvironment = await asActor(
      bearerHeaders,
      'POST',
      `/v1/projects/${seed.projectId}/environments`,
      { slug: 'tx43-bearer', name: 'TX.43 bearer' },
      { type: 'api_credential', id: operatorCredentialId },
    );
    const sessionEnvironmentId = sessionEnvironment.json<{ data: { id: string } }>().data.id;
    const bearerEnvironmentId = bearerEnvironment.json<{ data: { id: string } }>().data.id;

    await asActor(
      sessionHeaders,
      'PATCH',
      `/v1/environments/${sessionEnvironmentId}`,
      { enabled: false },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'PATCH',
      `/v1/environments/${bearerEnvironmentId}`,
      { enabled: false },
      { type: 'api_credential', id: operatorCredentialId },
    );

    await asActor(
      sessionHeaders,
      'PATCH',
      `/v1/treasuries/${seed.treasuryId}`,
      { enabled: false },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'PATCH',
      `/v1/treasuries/${seed.treasuryId}`,
      { enabled: true },
      { type: 'api_credential', id: operatorCredentialId },
    );

    await asActor(
      sessionHeaders,
      'POST',
      `/v1/treasuries/${seed.treasuryId}/check`,
      {},
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'POST',
      `/v1/treasuries/${seed.treasuryId}/check`,
      {},
      { type: 'api_credential', id: operatorCredentialId },
    );

    await asActor(
      sessionHeaders,
      'PATCH',
      `/v1/admin/credentials/${sessionTargetCredentialId}`,
      { action: 'disable' },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'PATCH',
      `/v1/admin/credentials/${bearerTargetCredentialId}`,
      { action: 'disable' },
      { type: 'api_credential', id: operatorCredentialId },
    );

    const sessionAlertId = await seedOpenFinding(`0x${'11'.repeat(32)}`);
    const bearerAlertId = await seedOpenFinding(`0x${'22'.repeat(32)}`);
    await asActor(
      sessionHeaders,
      'POST',
      `/v1/alerts/${sessionAlertId}/acknowledge`,
      { note: 'Session acknowledgement.' },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'POST',
      `/v1/alerts/${bearerAlertId}/acknowledge`,
      { note: 'Bearer acknowledgement.' },
      { type: 'api_credential', id: operatorCredentialId },
    );

    await asActor(
      sessionHeaders,
      'POST',
      '/v1/alerts/acknowledge-finding',
      { entityId: `0x${'33'.repeat(32)}`, note: 'Session finding acknowledgement.' },
      { type: 'dashboard_user', id: userId },
    );
    await asActor(
      bearerHeaders,
      'POST',
      '/v1/alerts/acknowledge-finding',
      { entityId: `0x${'44'.repeat(32)}`, note: 'Bearer finding acknowledgement.' },
      { type: 'api_credential', id: operatorCredentialId },
    );

    await asActor(sessionHeaders, 'POST', '/v1/admin/email/test', {}, { type: 'dashboard_user', id: userId });
    await asActor(
      bearerHeaders,
      'POST',
      '/v1/admin/email/test',
      {},
      { type: 'api_credential', id: operatorCredentialId },
    );
  });

  it('keeps reconciler funding attributed to cron', async () => {
    await handle.db
      .update(managedWallets)
      .set({ reconciliationEnabled: true })
      .where(eq(managedWallets.id, seed.managedWalletId));
    await handle.db.insert(fundingPolicies).values({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: ONE_ETH.toString(),
      targetBalanceWei: (2n * ONE_ETH).toString(),
      maximumTopUpWei: (5n * ONE_ETH).toString(),
      version: 1,
    });

    const logger = createLogger({ level: 'silent', serviceRole: 'cron-reconciler', environment: 'test' });
    const clock = createFixedClock(new Date('2026-09-23T12:00:00.000Z'));
    const config = loadConfig({
      serviceRole: 'cron-reconciler',
      env: validWebEnv({
        DATABASE_URL: process.env.DATABASE_URL,
        TREASURY_ADDRESS,
        FUNDING_ENABLED: 'true',
        TREASURY_PRIVATE_KEY: generatePrivateKey(),
        EMAIL_PROVIDER: 'log-only',
      }),
    });
    const container: Container = {
      config,
      logger,
      clock,
      idGenerator: { next: () => randomUUID() },
      database: { db: handle.db, pool: handle.pool, close: () => Promise.resolve() },
      repositories: {
        chains: createChainRepository(handle.db),
        treasuries: createTreasuryRepository(handle.db),
        balanceObservations: createBalanceObservationRepository(handle.db),
        apiCredentials: createApiCredentialRepository(handle.db),
        auditEvents: createAuditEventRepository(handle.db),
        serviceHeartbeats: createServiceHeartbeatRepository(handle.db),
        managedWallets: createManagedWalletRepository(handle.db),
        fundingPolicies: createFundingPolicyRepository(handle.db),
        projects: createProjectRepository(handle.db),
        environments: createEnvironmentRepository(handle.db),
        credentialScopes: createCredentialScopeRepository(handle.db),
        fundingOperations: createFundingOperationRepository(handle.db),
        fundingTransactions: createFundingTransactionRepository(handle.db),
        alerts: createAlertRepository(handle.db),
        reconciliationRuns: createReconciliationRunRepository(handle.db),
        reconciliationFunding: createReconciliationFundingQuery(handle.db),
        fundingHealth: createFundingHealthQuery(handle.db),
      },
      chainAdapters: createTestChainAdapterRegistry({
        signer: createFakeSigner({ address: TREASURY_ADDRESS }),
        balanceReader: createFakeBalanceReader({
          balances: {
            [TREASURY_ADDRESS]: 20n * ONE_ETH,
            [SEEDED_WALLET_ADDRESS]: ONE_ETH / 10n,
          },
        }),
        outgoingScanner: createFakeOutgoingScanner(),
        receiptTracker: createFakeReceiptTracker({ kind: 'confirmed', confirmedAt: clock.now() }),
      }),
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      operatorMutations: createOperatorMutationTransaction(handle.db),
      emailSender: createLogOnlyEmailSender(logger),
      close: () => Promise.resolve(),
    };

    const before = await auditIds();
    const outcome = await runWalletReconciler(container, `corr-${randomUUID()}`, {
      reconcileDeps: buildReconcileWalletsDependencies(container, {
        chainAdapters: container.chainAdapters,
        isFundingEnabled: true,
        isFundingKillSwitchActive: false,
      }),
    });
    expect(outcome.exitKind).toBe('success');
    expect(outcome.reconcileResult?.counters.funded).toBe(1);

    const created = await auditsAfter(before);
    expect(created.some((row) => row.action === 'reconciliation.run.completed')).toBe(true);
    for (const row of created) {
      expect(row.actorType, row.action).toBe('cron');
    }
  });

  async function insertCredential(name: string): Promise<string> {
    const generated = generateApiToken();
    const [row] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `${name}-${randomUUID()}`,
        role: 'read-only',
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (row === undefined) {
      throw new Error(`Failed to seed credential ${name}`);
    }
    return row.id;
  }

  async function insertAdminAndLogin(): Promise<string> {
    const password = await hashPassword(PASSWORD);
    const [user] = await handle.db
      .insert(dashboardUsers)
      .values({
        email: 'admin@example.com',
        displayName: 'Ada',
        role: 'admin',
        passwordHash: password.passwordHash,
        passwordParams: password.passwordParams,
      })
      .returning({ id: dashboardUsers.id });
    if (user === undefined) {
      throw new Error('failed to insert dashboard user');
    }
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(204);
    sessionCookie = sessionToken(login);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `chainbank_session=${sessionCookie}`, ...SESSION_HEADER },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json<{ user: { id: string } }>().user.id).toBe(user.id);
    return user.id;
  }

  async function asActor(
    headers: Record<string, string>,
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload: Record<string, unknown>,
    actor: { readonly type: 'dashboard_user' | 'api_credential'; readonly id: string },
  ) {
    const before = await auditIds();
    const response = await app.inject({ method, url, headers, payload });
    expect(response.statusCode, `${method} ${url} ${response.body}`).toBe(200);
    const created = await auditsAfter(before);
    expect(created.length, `${method} ${url} wrote no audit row`).toBeGreaterThan(0);
    for (const row of created) {
      expect(row.actorType, `${method} ${url} ${row.action}`).toBe(actor.type);
      expect(row.actorId, `${method} ${url} ${row.action}`).toBe(actor.id);
    }
    return response;
  }

  async function seedOpenFinding(entityId: string): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(alerts).values({
      id,
      alertType: TREASURY_FINDING_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId,
      state: 'open',
      firstTriggeredAt: new Date('2026-09-23T11:00:00.000Z'),
      lastEvaluatedAt: new Date('2026-09-23T11:00:00.000Z'),
      metadataJson: {},
    });
    return id;
  }

  async function auditIds(): Promise<ReadonlySet<string>> {
    const rows = await handle.db.select({ id: auditEvents.id }).from(auditEvents);
    return new Set(rows.map((row) => row.id));
  }

  async function auditsAfter(before: ReadonlySet<string>): Promise<readonly AuditEventRow[]> {
    const rows = await handle.db.select().from(auditEvents);
    return rows.filter((row) => !before.has(row.id));
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
