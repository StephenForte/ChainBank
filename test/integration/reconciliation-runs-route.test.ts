import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Container } from '../../src/container.js';
import { loadConfig } from '../../src/config/index.js';
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
  apiCredentials,
  apiCredentialScopes,
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

interface ReconciliationRunResponseBody {
  readonly data: readonly {
    readonly id: string;
    readonly finishedAt: string | null;
    readonly weiTransferred: string;
    readonly weiTransferredEther: string;
    readonly findings: readonly Record<string, unknown>[];
    readonly outgoingScanStatus: string;
  }[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
}

describe.skipIf(!integrationEnabled)('GET /v1/reconciliation-runs (integration, C19)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let app: AppInstance;
  let operatorToken: string;
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
    // Scope grant must not buy treasury-wide forensic data.
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
    const clock = createFixedClock();
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

  async function seedFinishedRun(input: {
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
    readonly weiTransferred?: string;
    readonly findings?: unknown;
    readonly runId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(reconciliationRuns).values({
      id,
      runId: input.runId ?? `run-${id}`,
      requestedBy: 'cron-reconciler',
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      walletsAssessed: 1,
      walletsFunded: 0,
      walletsNoop: 1,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred: input.weiTransferred ?? '0',
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: input.finishedAt === null ? 'not-run' : 'complete',
      findingsJson: input.findings ?? [],
      errorCode: null,
      errorSummary: null,
    });
    return id;
  }

  it('allows operator and read-only; denies project-service (with scopes) and cron roles', async () => {
    await seedFinishedRun({
      startedAt: new Date('2026-08-05T18:00:00.000Z'),
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
    });

    for (const token of [operatorToken, readOnlyToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/reconciliation-runs?limit=10&offset=0',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ReconciliationRunResponseBody>().pagination.total).toBe(1);
    }

    for (const [label, token] of [
      ['project-service-with-scope', projectServiceToken],
      ['cron-reconciler', cronReconcilerToken],
      ['cron-treasury-monitor', cronMonitorToken],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/reconciliation-runs',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, label).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_ROLE' } });
    }
  });

  it('paginates with string query params and returns a true total', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedFinishedRun({
        startedAt: new Date(`2026-08-0${String(index + 1)}T12:00:00.000Z`),
        finishedAt: new Date(`2026-08-0${String(index + 1)}T12:00:10.000Z`),
      });
    }

    const page = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=2&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(page.statusCode).toBe(200);
    const body = page.json<ReconciliationRunResponseBody>();
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 2, offset: 0, total: 3 });

    const second = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=2&offset=2',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<ReconciliationRunResponseBody>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.pagination).toEqual({ limit: 2, offset: 2, total: 3 });

    const rejected = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=101&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('returns weiTransferred above 2^64 as a decimal string', async () => {
    const wei = '20000000000000000000';
    await seedFinishedRun({
      startedAt: new Date('2026-08-05T18:00:00.000Z'),
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
      weiTransferred: wei,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=10&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ReconciliationRunResponseBody>();
    expect(body.data[0]?.weiTransferred).toBe(wei);
    expect(body.data[0]?.weiTransferredEther).toBe('20');
  });

  it('returns 200 with an unrecognised finding kind present in the body', async () => {
    const unknownFinding = {
      kind: 'future_detector_signal',
      severity: 'critical',
      treasuryId: seed.treasuryId,
      detail: 'must-not-be-dropped',
    };
    await seedFinishedRun({
      startedAt: new Date('2026-08-05T18:00:00.000Z'),
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
      findings: [unknownFinding],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=10&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ReconciliationRunResponseBody>();
    expect(body.data[0]?.findings).toEqual([unknownFinding]);
  });

  it('passes non-string kind/severity through without coercion', async () => {
    // Added at planner review. The response schema previously declared
    // `kind`/`severity` as strings; fast-json-stringify COERCES a declared
    // property rather than rejecting it, so `severity: null` came back as `""`
    // and `severity: { level: 'critical' }` as `"[object Object]"`. Erasing a
    // finding's severity is the silent evidence loss this endpoint exists to
    // prevent, so the schema now declares no finding properties at all.
    const findings = [
      { kind: 'future_detector', severity: 'critical', context: { inner: { deep: 'v' }, list: [1, 2, 3] } },
      { kind: 'null_severity', severity: null, detail: 'kept' },
      { kind: 42, severity: 'critical', detail: 'numeric kind' },
      { kind: 'object_severity', severity: { level: 'critical' }, detail: 'kept' },
    ];
    await seedFinishedRun({
      startedAt: new Date('2026-08-05T12:00:00.000Z'),
      finishedAt: new Date('2026-08-05T12:00:20.000Z'),
      findings,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=10&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ReconciliationRunResponseBody>().data[0]?.findings).toEqual(findings);
  });

  it('wraps a non-object finding rather than dropping it', async () => {
    await seedFinishedRun({
      startedAt: new Date('2026-08-05T06:00:00.000Z'),
      finishedAt: new Date('2026-08-05T06:00:20.000Z'),
      findings: ['a bare string finding', null, 7],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=10&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ReconciliationRunResponseBody>().data[0]?.findings).toEqual([
      { kind: 'unrecognised_finding_shape', severity: 'unknown', value: 'a bare string finding' },
      { kind: 'unrecognised_finding_shape', severity: 'unknown', value: null },
      { kind: 'unrecognised_finding_shape', severity: 'unknown', value: 7 },
    ]);
  });

  it('returns unfinished runs with finishedAt null, distinct from finished runs', async () => {
    const unfinishedId = await seedFinishedRun({
      startedAt: new Date('2026-08-06T06:00:00.000Z'),
      finishedAt: null,
    });
    const finishedId = await seedFinishedRun({
      startedAt: new Date('2026-08-05T18:00:00.000Z'),
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation-runs?limit=10&offset=0',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ReconciliationRunResponseBody>();
    expect(body.pagination.total).toBe(2);

    const unfinished = body.data.find((row) => row.id === unfinishedId);
    const finished = body.data.find((row) => row.id === finishedId);
    expect(unfinished?.finishedAt).toBeNull();
    expect(unfinished?.outgoingScanStatus).toBe('not-run');
    expect(finished?.finishedAt).toBe('2026-08-05T18:00:20.000Z');
    expect(finished?.outgoingScanStatus).toBe('complete');
  });
});
