import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  maybeNotifyReconciliationFailure,
  RECONCILIATION_FAILURE_ALERT_TYPE,
} from '../../src/app/alerts/notify-reconciliation-failure.js';
import type { EmailMessage, EmailSender, ReconciliationRun } from '../../src/app/ports.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createReconciliationRunRepository } from '../../src/infrastructure/db/repositories/reconciliation-run-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import { createLogger } from '../../src/observability/logger.js';
import { createFixedClock } from '../support/clock.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

describe.skipIf(!integrationEnabled)('reconciliation failure alert lifecycle', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('listRecent returns newest-first by started_at', async () => {
    const runs = createReconciliationRunRepository(handle.db);
    const clock = createFixedClock(new Date('2026-08-01T10:00:00.000Z'));

    const olderId = randomUUID();
    const newerId = randomUUID();
    await runs.insertStarted({
      id: olderId,
      runId: `run-older-${randomUUID()}`,
      requestedBy: 'cron',
      startedAt: clock.now(),
    });
    await runs.markFinished({
      id: olderId,
      finishedAt: clock.now(),
      walletsAssessed: 0,
      walletsFunded: 0,
      walletsNoop: 0,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred: 0n,
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: 'complete',
      findings: [],
      errorCode: 'INTERNAL_ERROR',
      errorSummary: 'older',
    });

    clock.advance(60_000);
    await runs.insertStarted({
      id: newerId,
      runId: `run-newer-${randomUUID()}`,
      requestedBy: 'cron',
      startedAt: clock.now(),
    });
    await runs.markFinished({
      id: newerId,
      finishedAt: clock.now(),
      walletsAssessed: 0,
      walletsFunded: 0,
      walletsNoop: 0,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred: 0n,
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: 'complete',
      findings: [],
      errorCode: undefined,
      errorSummary: undefined,
    });

    const recent = await runs.listRecent(10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0]?.id).toBe(newerId);
    expect(recent[1]?.id).toBe(olderId);
  });

  it('creates exactly one alert row across consecutive failures and resolves without deleting', async () => {
    const alerts = createAlertRepository(handle.db);
    const auditEvents = createAuditEventRepository(handle.db);
    const reconciliationRuns = createReconciliationRunRepository(handle.db);
    const managedWallets = createManagedWalletRepository(handle.db);
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };
    const clock = createFixedClock(new Date('2026-08-01T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }

    const deps = {
      alerts,
      reconciliationRuns,
      managedWallets,
      emailSender,
      auditEvents,
      clock,
      logger,
    };
    const base = {
      treasury,
      failureAlertThreshold: 2,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      actor: { type: 'cron' as const, id: 'cred-1' },
    };

    const finishedIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      clock.advance(60_000);
      const id = randomUUID();
      finishedIds.push(id);
      await reconciliationRuns.insertStarted({
        id,
        runId: `run-fail-${String(i)}`,
        requestedBy: 'cron',
        startedAt: clock.now(),
      });
      const finished = await reconciliationRuns.markFinished({
        id,
        finishedAt: clock.now(),
        walletsAssessed: 1,
        walletsFunded: 0,
        walletsNoop: 0,
        walletsBlocked: 0,
        walletsFailed: 1,
        weiTransferred: 0n,
        submissionUnknownResolved: 0,
        submissionUnknownLeftPending: 0,
        unexplainedTransferCount: 0,
        outgoingScanStatus: 'complete',
        findings: [
          {
            kind: 'wallet_assessment_failed',
            severity: 'warning',
            walletId: seed.managedWalletId,
            reason: 'assessment failed',
          },
        ],
        errorCode: 'SIGNER_UNAVAILABLE',
        errorSummary: 'signer missing',
      });

      await maybeNotifyReconciliationFailure(deps, {
        ...base,
        run: finished,
        operationId: `op-${String(i)}`,
      });
    }

    expect(messages).toHaveLength(1);

    const open = await alerts.findOpenByEntity(
      'treasury',
      seed.treasuryId,
      RECONCILIATION_FAILURE_ALERT_TYPE,
    );
    expect(open).toBeDefined();
    expect(open?.severity).toBe('critical');
    expect(open?.metadata.consecutiveFailureCount).toBe(3);
    const alertId = open?.id;
    expect(alertId).toBeDefined();

    const openCount = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts WHERE alert_type = $1 AND entity_id = $2 AND state = 'open'`,
      [RECONCILIATION_FAILURE_ALERT_TYPE, seed.treasuryId],
    );
    expect(openCount.rows[0]?.count).toBe('1');

    const auditCount = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE action IN ('treasury.alert.email.sent', 'treasury.alert.email.failed')`,
    );
    expect(Number(auditCount.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    clock.advance(60_000);
    const successId = randomUUID();
    await reconciliationRuns.insertStarted({
      id: successId,
      runId: 'run-success',
      requestedBy: 'cron',
      startedAt: clock.now(),
    });
    const success: ReconciliationRun = await reconciliationRuns.markFinished({
      id: successId,
      finishedAt: clock.now(),
      walletsAssessed: 1,
      walletsFunded: 0,
      walletsNoop: 1,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred: 0n,
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: 'complete',
      findings: [],
      errorCode: undefined,
      errorSummary: undefined,
    });

    const resolved = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: success,
      operationId: 'op-success',
    });
    expect(resolved.kind).toBe('resolved');
    expect(messages).toHaveLength(1);

    expect(
      await alerts.findOpenByEntity('treasury', seed.treasuryId, RECONCILIATION_FAILURE_ALERT_TYPE),
    ).toBeUndefined();

    const row = await handle.pool.query<{ state: string; has_resolved: boolean }>(
      `SELECT state, resolved_at IS NOT NULL AS has_resolved FROM alerts WHERE id = $1`,
      [alertId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.state).toBe('resolved');
    expect(row.rows[0]?.has_resolved).toBe(true);

    // Policy-refusal run must not re-open or resolve (nothing open to resolve).
    clock.advance(60_000);
    const refusalId = randomUUID();
    await reconciliationRuns.insertStarted({
      id: refusalId,
      runId: 'run-refusal',
      requestedBy: 'cron',
      startedAt: clock.now(),
    });
    const refusal = await reconciliationRuns.markFinished({
      id: refusalId,
      finishedAt: clock.now(),
      walletsAssessed: 0,
      walletsFunded: 0,
      walletsNoop: 0,
      walletsBlocked: 0,
      walletsFailed: 0,
      weiTransferred: 0n,
      submissionUnknownResolved: 0,
      submissionUnknownLeftPending: 0,
      unexplainedTransferCount: 0,
      outgoingScanStatus: 'complete',
      findings: [],
      errorCode: 'FUNDING_DISABLED',
      errorSummary: 'Funding is disabled.',
    });
    const skipped = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: refusal,
      operationId: 'op-refusal',
    });
    expect(skipped).toEqual({ kind: 'skipped', reason: 'policy-refusal' });
    expect(messages).toHaveLength(1);
    expect(finishedIds).toHaveLength(3);
  });
});
