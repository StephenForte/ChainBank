import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
import {
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
} from '../../src/app/alerts/notify-treasury-finding.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createApiCredentialRepository } from '../../src/infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from '../../src/infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from '../../src/infrastructure/db/repositories/environment-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingPolicyRepository } from '../../src/infrastructure/db/repositories/funding-policy-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from '../../src/infrastructure/db/repositories/project-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createServiceHeartbeatRepository } from '../../src/infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  alerts,
  apiCredentials,
  apiCredentialScopes,
  auditEvents,
  reconciliationRuns,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import { createFakeReceiptTracker, createFakeSigner } from '../support/funding-fakes.js';
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
import type { Role } from '../../src/domain/auth/roles.js';
import { eq } from 'drizzle-orm';

interface AlertResponseBody {
  readonly data: readonly {
    readonly id: string;
    readonly alertType: string;
    readonly state: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly acknowledgementNote: string | null;
    readonly acknowledgedBy: string | null;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
}

describe.skipIf(!integrationEnabled)('GET/POST /v1/alerts (integration, C20)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let operatorToken: string;
  let operatorCredentialId: string;
  let readOnlyToken: string;
  let projectServiceToken: string;
  let cronReconcilerToken: string;
  let cronMonitorToken: string;

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

    const cronReconciler = generateApiToken();
    cronReconcilerToken = cronReconciler.token;
    await handle.db.insert(apiCredentials).values({
      name: `cron-reconciler-${randomUUID()}`,
      role: 'cron-reconciler' satisfies Role,
      tokenHash: cronReconciler.tokenHash,
      tokenPrefix: cronReconciler.tokenPrefix,
    });

    const cronMonitor = generateApiToken();
    cronMonitorToken = cronMonitor.token;
    await handle.db.insert(apiCredentials).values({
      name: `cron-monitor-${randomUUID()}`,
      role: 'cron-treasury-monitor' satisfies Role,
      tokenHash: cronMonitor.tokenHash,
      tokenPrefix: cronMonitor.tokenPrefix,
    });

    const config = loadConfig({
      serviceRole: 'web',
      env: validWebEnv({
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    });
    const clock = createFixedClock(new Date('2026-08-06T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    const container: Container = {
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
      },
      balanceReader: {
        readBalance: () =>
          Promise.resolve({
            kind: 'observed',
            balanceWei: 0n,
            blockNumber: 1n,
            observedAt: new Date(),
          }),
        verifyChainId: () => Promise.resolve({ matches: true, observedChainId: 11_155_111 }),
      },
      treasurySigner: createFakeSigner({}),
      fundingDispatchLock: createFundingDispatchLock(handle.db),
      transactionReceiptTracker: createFakeReceiptTracker({ kind: 'pending' }),
      treasuryOutgoingScanner: {} as Container['treasuryOutgoingScanner'],
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

  async function seedAlert(input: {
    readonly alertType: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly state: string;
    readonly firstTriggeredAt: Date;
    readonly lastSentAt?: Date | null;
    readonly resolvedAt?: Date | null;
    readonly metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(alerts).values({
      id,
      alertType: input.alertType,
      severity: 'critical',
      entityType: input.entityType,
      entityId: input.entityId,
      state: input.state,
      firstTriggeredAt: input.firstTriggeredAt,
      lastEvaluatedAt: input.firstTriggeredAt,
      lastSentAt: input.lastSentAt ?? null,
      resolvedAt: input.resolvedAt ?? null,
      metadataJson: input.metadata ?? {},
    });
    return id;
  }

  it('allows alert:read for operator and read-only; denies project-service with scopes and cron roles', async () => {
    await seedAlert({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId: `0x${'aa'.repeat(32)}`,
      state: 'open',
      firstTriggeredAt: new Date('2026-08-05T18:00:00.000Z'),
    });

    for (const token of [operatorToken, readOnlyToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/alerts?limit=10&offset=0',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<AlertResponseBody>().pagination.total).toBe(1);
    }

    for (const [label, token] of [
      ['project-service-with-scope', projectServiceToken],
      ['cron-reconciler', cronReconcilerToken],
      ['cron-treasury-monitor', cronMonitorToken],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/alerts',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, label).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_ROLE' } });
    }
  });

  it('paginates with string query params, true total, and composing filters', async () => {
    const t0 = new Date('2026-08-01T12:00:00.000Z');
    const t1 = new Date('2026-08-02T12:00:00.000Z');
    const t2 = new Date('2026-08-03T12:00:00.000Z');
    await seedAlert({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId: 'a',
      state: 'open',
      firstTriggeredAt: t0,
    });
    await seedAlert({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId: 'b',
      state: 'acknowledged',
      firstTriggeredAt: t1,
    });
    await seedAlert({
      alertType: 'treasury_balance',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      state: 'resolved',
      firstTriggeredAt: t2,
      resolvedAt: t2,
    });

    const page = await app.inject({
      method: 'GET',
      url: `/v1/alerts?limit=1&offset=0&alertType=${TREASURY_FINDING_ALERT_TYPE}&entityType=${TREASURY_FINDING_ENTITY_TYPE}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(page.statusCode).toBe(200);
    const body = page.json<AlertResponseBody>();
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ limit: 1, offset: 0, total: 2 });
    expect(body.data[0]?.entityId).toBe('b');

    const openOnly = await app.inject({
      method: 'GET',
      url: `/v1/alerts?alertType=${TREASURY_FINDING_ALERT_TYPE}&state=open`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(openOnly.statusCode).toBe(200);
    const openBody = openOnly.json<AlertResponseBody>();
    expect(openBody.pagination.total).toBe(1);
    expect(openBody.data[0]?.entityId).toBe('a');
  });

  it('acknowledges with a required note, audits, and leaves findings_json untouched', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const findings = [
      {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: seed.treasuryId,
        transactionHash: hash,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '1000000000000000000',
        nonce: 3,
        blockNumber: '11425869',
      },
    ];
    const runId = randomUUID();
    await handle.db.insert(reconciliationRuns).values({
      id: runId,
      runId: `run-${runId}`,
      requestedBy: 'cron-reconciler',
      startedAt: new Date('2026-08-05T18:00:00.000Z'),
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
      unexplainedTransferCount: 1,
      outgoingScanStatus: 'complete',
      findingsJson: findings,
    });
    const beforeFindings = await handle.pool.query<{ findings_json: unknown }>(
      'SELECT findings_json FROM reconciliation_runs WHERE id = $1',
      [runId],
    );
    const findingsBefore = JSON.stringify(beforeFindings.rows[0]?.findings_json);

    const alertId = await seedAlert({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId: hash,
      state: 'open',
      firstTriggeredAt: new Date('2026-08-05T18:00:20.000Z'),
      lastSentAt: new Date('2026-08-05T18:00:21.000Z'),
      metadata: { transactionHash: hash, runId: `run-${runId}` },
    });

    const empty = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${alertId}/acknowledge`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { note: '   ' },
    });
    // Schema minLength:1 accepts whitespace; application layer rejects after trim.
    // If Fastify rejects first, still no state change — either path is fail-closed.
    expect([400, 422]).toContain(empty.statusCode);

    const missing = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${alertId}/acknowledge`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const readOnlyDenied = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${alertId}/acknowledge`,
      headers: { authorization: `Bearer ${readOnlyToken}`, 'content-type': 'application/json' },
      payload: { note: 'read-only must not acknowledge' },
    });
    expect(readOnlyDenied.statusCode).toBe(403);
    expect(readOnlyDenied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_ROLE' } });

    const stillOpen = await handle.db.query.alerts.findFirst({ where: eq(alerts.id, alertId) });
    expect(stillOpen?.state).toBe('open');

    const ack = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${alertId}/acknowledge`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { note: 'Confirmed operator hand-send to HARVEST on 2026-08-05.' },
    });
    expect(ack.statusCode).toBe(200);
    const ackBody = ack.json<{
      data: { state: string; acknowledgementNote: string; acknowledgedBy: string };
    }>();
    expect(ackBody.data.state).toBe('acknowledged');
    expect(ackBody.data.acknowledgementNote).toBe('Confirmed operator hand-send to HARVEST on 2026-08-05.');
    expect(ackBody.data.acknowledgedBy).toBe(operatorCredentialId);

    const audit = await handle.db.query.auditEvents.findFirst({
      where: eq(auditEvents.action, 'treasury.alert.acknowledged'),
    });
    expect(audit?.actorId).toBe(operatorCredentialId);
    expect(audit?.entityId).toBe(alertId);
    expect(audit?.metadata).toMatchObject({
      note: 'Confirmed operator hand-send to HARVEST on 2026-08-05.',
    });

    const afterFindings = await handle.pool.query<{ findings_json: unknown }>(
      'SELECT findings_json FROM reconciliation_runs WHERE id = $1',
      [runId],
    );
    expect(JSON.stringify(afterFindings.rows[0]?.findings_json)).toBe(findingsBefore);
    const findingsAfter = afterFindings.rows[0]?.findings_json as Array<{ severity: string }>;
    expect(findingsAfter[0]?.severity).toBe('critical');
  });

  it('acknowledgement sticks across re-observation; a distinct hash still alerts', async () => {
    const { notifyTreasuryFinding } = await import('../../src/app/alerts/notify-treasury-finding.js');
    const alertsRepo = createAlertRepository(handle.db);
    const auditRepo = createAuditEventRepository(handle.db);
    const messages: { subject: string }[] = [];
    const emailSender = {
      send(message: { subject: string }) {
        messages.push(message);
        return Promise.resolve({
          kind: 'sent' as const,
          providerMessageId: `msg-${String(messages.length)}`,
        });
      },
    };
    const clock = createFixedClock(new Date('2026-08-06T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }

    const hashA = `0x${'a1'.repeat(32)}`;
    const hashB = `0x${'b2'.repeat(32)}`;
    const deps = { alerts: alertsRepo, emailSender, auditEvents: auditRepo, clock, logger };

    const opened = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashA,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '1000000000000000000',
        nonce: 3,
        blockNumber: '11425869',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(opened.kind).toBe('opened');
    expect(messages).toHaveLength(1);

    const ack = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${opened.alertId}/acknowledge`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { note: 'Benign hand-send; watermark will re-scan this window.' },
    });
    expect(ack.statusCode).toBe(200);

    const reobserved = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashA,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '1000000000000000000',
        nonce: 3,
        blockNumber: '11425869',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(reobserved).toEqual({ kind: 'deduped', alertId: opened.alertId });
    expect(messages).toHaveLength(1);

    const countA = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
       WHERE entity_type = $1 AND entity_id = $2 AND alert_type = $3`,
      [TREASURY_FINDING_ENTITY_TYPE, hashA, TREASURY_FINDING_ALERT_TYPE],
    );
    expect(countA.rows[0]?.count).toBe('1');

    const second = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashB,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '500000000000000000',
        nonce: 4,
        blockNumber: '11425870',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(second.kind).toBe('opened');
    expect(messages).toHaveLength(2);
  });

  it('re-alerts outgoing_scan_incomplete after acknowledgement without silencing or overwriting the note', async () => {
    const { notifyTreasuryFinding, treasuryFindingAlertEntityId } =
      await import('../../src/app/alerts/notify-treasury-finding.js');
    const alertsRepo = createAlertRepository(handle.db);
    const auditRepo = createAuditEventRepository(handle.db);
    const messages: { subject: string }[] = [];
    const emailSender = {
      send(message: { subject: string }) {
        messages.push(message);
        return Promise.resolve({
          kind: 'sent' as const,
          providerMessageId: `msg-${String(messages.length)}`,
        });
      },
    };
    const clock = createFixedClock(new Date('2026-08-06T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }

    const finding = {
      kind: 'outgoing_scan_incomplete' as const,
      severity: 'critical' as const,
      treasuryId: treasury.id,
      errorCode: 'RPC_UNAVAILABLE',
      reason: 'tip read failed',
    };
    const entityId = treasuryFindingAlertEntityId(finding);
    const deps = { alerts: alertsRepo, emailSender, auditEvents: auditRepo, clock, logger };
    const note = 'Provider outage — aware; detector may be dark.';

    const first = await notifyTreasuryFinding(deps, {
      finding,
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(first.kind).toBe('opened');
    expect(messages).toHaveLength(1);

    const ack = await app.inject({
      method: 'POST',
      url: `/v1/alerts/${first.alertId}/acknowledge`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { note },
    });
    expect(ack.statusCode).toBe(200);

    const second = await notifyTreasuryFinding(deps, {
      finding,
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(second.kind).toBe('opened');
    expect(second.alertId).not.toBe(first.alertId);
    expect(messages).toHaveLength(2);

    const third = await notifyTreasuryFinding(deps, {
      finding,
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['ops@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(third).toEqual({ kind: 'deduped', alertId: second.alertId });
    expect(messages).toHaveLength(2);

    const prior = await alertsRepo.findById(first.alertId);
    expect(prior?.state).toBe('acknowledged');
    expect(prior?.acknowledgementNote).toBe(note);
    expect(prior?.acknowledgedBy).toBe(operatorCredentialId);

    const preferred = await alertsRepo.findOpenOrAcknowledgedByEntity(
      TREASURY_FINDING_ENTITY_TYPE,
      entityId,
      TREASURY_FINDING_ALERT_TYPE,
    );
    expect(preferred?.id).toBe(second.alertId);
    expect(preferred?.state).toBe('open');

    const rowCount = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
       WHERE entity_type = $1 AND entity_id = $2 AND alert_type = $3`,
      [TREASURY_FINDING_ENTITY_TYPE, entityId, TREASURY_FINDING_ALERT_TYPE],
    );
    expect(rowCount.rows[0]?.count).toBe('2');
  });
});
