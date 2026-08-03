import { describe, expect, it, vi } from 'vitest';
import {
  classifyReconciliationRun,
  countConsecutiveFailures,
  maybeNotifyReconciliationFailure,
  RECONCILIATION_FAILURE_ALERT_TYPE,
} from '../../../../src/app/alerts/notify-reconciliation-failure.js';
import { TREASURY_BALANCE_ALERT_TYPE } from '../../../../src/app/alerts/evaluate-treasury-alerts.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailMessage,
  EmailSender,
  ManagedWallet,
  ManagedWalletRepository,
  ReconciliationRun,
  ReconciliationRunRepository,
  StoredOpenAlert,
  Treasury,
} from '../../../../src/app/ports.js';
import { parseEtherToWei } from '../../../../src/domain/wei.js';
import { createLogger } from '../../../../src/observability/logger.js';

const treasury: Treasury = {
  id: '11111111-1111-1111-1111-111111111111',
  chain: {
    id: '22222222-2222-2222-2222-222222222222',
    slug: 'ethereum-sepolia',
    chainId: 11155111,
    displayName: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
  },
  address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
  addressDisplay: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  thresholds: {
    criticalBalanceWei: parseEtherToWei('0.3', 'c'),
    warningBalanceWei: parseEtherToWei('0.75', 'w'),
    recoveryBalanceWei: parseEtherToWei('1.5', 'r'),
    minimumReserveWei: parseEtherToWei('0.1', 'm'),
  },
  status: 'healthy',
  lastObservedBalanceWei: undefined,
  lastObservedAt: undefined,
  lastCheckedAt: undefined,
  lastCheckErrorCode: undefined,
  lastOutgoingScanBlock: undefined,
  lastOutgoingScanAt: undefined,
  lastOutgoingScanNonce: undefined,
  enabled: true,
};

const WALLET_ID = '44444444-4444-4444-8444-444444444444';

const managedWallet: ManagedWallet = {
  id: WALLET_ID,
  project: { id: 'p1', slug: 'demo', name: 'Demo', enabled: true },
  environment: { id: 'e1', projectId: 'p1', slug: 'dev', name: 'Dev', enabled: true },
  chain: treasury.chain,
  role: 'signer',
  address: '0x2222222222222222222222222222222222222222',
  addressDisplay: '0x2222222222222222222222222222222222222222',
  enabled: true,
  criticalAtStartup: false,
  reconciliationEnabled: true,
  policy: undefined,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

function makeRun(
  overrides: Partial<ReconciliationRun> & { readonly id: string; readonly runId: string },
): ReconciliationRun {
  return {
    requestedBy: 'cron-1',
    startedAt: new Date('2026-08-01T12:00:00.000Z'),
    finishedAt: new Date('2026-08-01T12:01:00.000Z'),
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
    ...overrides,
  };
}

function createFakeAlerts(): AlertRepository & {
  readonly rows: Map<string, StoredOpenAlert>;
  readonly resolved: StoredOpenAlert[];
} {
  const rows = new Map<string, StoredOpenAlert>();
  const resolved: StoredOpenAlert[] = [];
  let seq = 0;

  return {
    rows,
    resolved,
    async findOpenByEntity(entityType, entityId, alertType) {
      return Promise.resolve(
        [...rows.values()].find(
          (row) => row.entityType === entityType && row.entityId === entityId && row.alertType === alertType,
        ),
      );
    },
    async insertOpen(input) {
      const id = `alert-${String(++seq)}`;
      const row: StoredOpenAlert = {
        id,
        alertType: input.alertType,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
        firstTriggeredAt: input.firstTriggeredAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        lastSentAt: undefined,
        pendingEmail: input.pendingEmail,
        metadata: { ...input.metadata, pendingEmail: input.pendingEmail },
      };
      rows.set(id, row);
      return Promise.resolve(row);
    },
    async markEscalated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        throw new Error('missing');
      }
      const next: StoredOpenAlert = {
        ...existing,
        severity: 'critical',
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: input.pendingEmail,
        metadata: { ...existing.metadata, pendingEmail: input.pendingEmail },
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    async markPendingEmail(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        throw new Error('missing');
      }
      const next: StoredOpenAlert = {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: input.pendingEmail,
        metadata: { ...existing.metadata, ...(input.metadata ?? {}), pendingEmail: input.pendingEmail },
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    async clearPendingEmail(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        throw new Error('missing');
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: StoredOpenAlert = {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    async acknowledgeSend(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        throw new Error('missing');
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: StoredOpenAlert = {
        ...existing,
        lastSentAt: input.lastSentAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    async resolve(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        throw new Error('missing');
      }
      rows.delete(input.id);
      const closed = {
        ...existing,
        pendingEmail: undefined,
        lastEvaluatedAt: input.lastEvaluatedAt,
      };
      resolved.push(closed);
      return Promise.resolve(closed);
    },
    async touchLastEvaluated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        return Promise.resolve();
      }
      rows.set(input.id, {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        metadata:
          input.metadata === undefined ? existing.metadata : { ...existing.metadata, ...input.metadata },
      });
      return Promise.resolve();
    },
  };
}

function createRunRepo(initial: ReconciliationRun[] = []): ReconciliationRunRepository & {
  readonly runs: ReconciliationRun[];
  add(run: ReconciliationRun): void;
} {
  const runs = [...initial];
  return {
    runs,
    add(run) {
      runs.push(run);
    },
    insertStarted() {
      return Promise.reject(new Error('unused'));
    },
    markFinished() {
      return Promise.reject(new Error('unused'));
    },
    findById() {
      return Promise.resolve(undefined);
    },
    listRecent(limit) {
      const sorted = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return Promise.resolve(sorted.slice(0, limit));
    },
  };
}

function createSender(behavior: 'sent' | 'fail' | (() => 'sent' | 'fail') = 'sent'): {
  readonly sender: EmailSender;
  readonly messages: EmailMessage[];
} {
  const messages: EmailMessage[] = [];
  return {
    messages,
    sender: {
      send(message) {
        messages.push(message);
        const outcome = typeof behavior === 'function' ? behavior() : behavior;
        if (outcome === 'fail') {
          return Promise.resolve({
            kind: 'failed' as const,
            errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' as const,
            reason: 'simulated outage',
          });
        }
        return Promise.resolve({
          kind: 'sent' as const,
          providerMessageId: `msg-${String(messages.length)}`,
        });
      },
    },
  };
}

function createClock(start: Date): { now: () => Date; advanceMs: (ms: number) => void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

function createManagedWallets(): ManagedWalletRepository {
  return {
    insert: vi.fn(),
    findById: (id) => Promise.resolve(id === WALLET_ID ? managedWallet : undefined),
    list: vi.fn(),
    update: vi.fn(),
  };
}

describe('classifyReconciliationRun / countConsecutiveFailures', () => {
  it('treats error_code runs as failures and FUNDING_DISABLED as neutral', () => {
    expect(
      classifyReconciliationRun(
        makeRun({ id: '1', runId: 'r1', errorCode: 'SIGNER_UNAVAILABLE', errorSummary: 'x' }),
      ),
    ).toBe('failure');
    expect(
      classifyReconciliationRun(
        makeRun({ id: '2', runId: 'r2', errorCode: 'FUNDING_DISABLED', errorSummary: 'disabled' }),
      ),
    ).toBe('neutral');
    expect(classifyReconciliationRun(makeRun({ id: '3', runId: 'r3' }))).toBe('success');
    expect(
      classifyReconciliationRun(
        makeRun({
          id: '4',
          runId: 'r4',
          finishedAt: undefined,
          errorCode: 'INTERNAL_ERROR',
          errorSummary: 'x',
        }),
      ),
    ).toBe('neutral');
  });

  it('does not treat an incomplete scan alone as failure', () => {
    // Degrades crash-orphan detection; says nothing about whether funding worked.
    expect(
      classifyReconciliationRun(
        makeRun({
          id: '1',
          runId: 'r1',
          outgoingScanStatus: 'incomplete',
          walletsAssessed: 2,
          walletsNoop: 2,
        }),
      ),
    ).toBe('success');
  });

  it('treats a sweep that funded nothing while failing wallets as a failure', () => {
    // Per-wallet errors never reach error_code, so without this a fully failed
    // sweep would count as success — and a success resolves an open alert,
    // reporting recovery while nothing was funded (P4-US3 silent degradation).
    expect(
      classifyReconciliationRun(
        makeRun({
          id: '1',
          runId: 'r1',
          walletsAssessed: 3,
          walletsFunded: 0,
          walletsFailed: 3,
        }),
      ),
    ).toBe('failure');
  });

  it('treats partial progress as success even when some wallets failed', () => {
    expect(
      classifyReconciliationRun(
        makeRun({
          id: '1',
          runId: 'r1',
          walletsAssessed: 3,
          walletsFunded: 2,
          walletsFailed: 1,
        }),
      ),
    ).toBe('success');
  });

  it('treats a clean sweep with nothing to do as success', () => {
    expect(classifyReconciliationRun(makeRun({ id: '1', runId: 'r1', walletsAssessed: 0 }))).toBe('success');
  });

  it('skips neutrals when counting consecutive failures', () => {
    const recent = [
      makeRun({
        id: '3',
        runId: 'r3',
        startedAt: new Date('2026-08-01T12:03:00.000Z'),
        errorCode: 'INTERNAL_ERROR',
        errorSummary: 'x',
      }),
      makeRun({
        id: '2',
        runId: 'r2',
        startedAt: new Date('2026-08-01T12:02:00.000Z'),
        errorCode: 'FUNDING_DISABLED',
        errorSummary: 'disabled',
      }),
      makeRun({
        id: '1',
        runId: 'r1',
        startedAt: new Date('2026-08-01T12:01:00.000Z'),
        errorCode: 'SIGNER_UNAVAILABLE',
        errorSummary: 'x',
      }),
    ];
    expect(countConsecutiveFailures(recent)).toBe(2);
  });
});

describe('maybeNotifyReconciliationFailure', () => {
  it('opens and sends once when the consecutive threshold is reached; dedupes further failures; resolves on success', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-08-01T12:00:00.000Z'));
    const runs = createRunRepo();
    const managedWallets = createManagedWallets();
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const deps = {
      alerts,
      reconciliationRuns: runs,
      managedWallets,
      emailSender: sender,
      auditEvents,
      clock,
      logger,
    };

    const threshold = 3;
    const base = {
      treasury,
      failureAlertThreshold: threshold,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      actor: { type: 'cron' as const, id: 'cred-1' },
    };

    // threshold - 1 failures → no alert
    for (let i = 1; i < threshold; i += 1) {
      clock.advanceMs(60_000);
      const run = makeRun({
        id: `id-${String(i)}`,
        runId: `run-${String(i)}`,
        startedAt: clock.now(),
        finishedAt: clock.now(),
        errorCode: 'SIGNER_UNAVAILABLE',
        errorSummary: 'signer missing',
        findings: [
          {
            kind: 'wallet_assessment_failed',
            severity: 'warning',
            walletId: WALLET_ID,
            reason: 'boom',
          },
        ],
      });
      runs.add(run);
      const result = await maybeNotifyReconciliationFailure(deps, {
        ...base,
        run,
        operationId: `op-${String(i)}`,
      });
      expect(result).toEqual({ kind: 'skipped', reason: 'below-threshold' });
    }
    expect(messages).toHaveLength(0);
    expect(alerts.rows.size).toBe(0);

    // threshold reached → open + one send
    clock.advanceMs(60_000);
    const openingRun = makeRun({
      id: 'id-3',
      runId: 'run-3',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      errorCode: 'SIGNER_UNAVAILABLE',
      errorSummary: 'signer missing',
      findings: [
        {
          kind: 'wallet_assessment_failed',
          severity: 'warning',
          walletId: WALLET_ID,
          reason: 'boom',
        },
      ],
    });
    runs.add(openingRun);
    const opened = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: openingRun,
      operationId: 'op-3',
    });
    expect(opened).toEqual({ kind: 'opened', alertId: 'alert-1', email: 'sent' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toMatch(/RECONCILE/);
    expect(messages[0]?.text).toContain('demo/dev');
    expect(messages[0]?.text).toContain('SIGNER_UNAVAILABLE');
    const stored = [...alerts.rows.values()][0];
    expect(stored?.alertType).toBe(RECONCILIATION_FAILURE_ALERT_TYPE);
    expect(stored?.severity).toBe('critical');
    expect(stored?.pendingEmail).toBeUndefined();
    expect(stored?.metadata.consecutiveFailureCount).toBe(3);
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'treasury.alert.email.sent' }),
    );

    // continued failures → no duplicate send
    clock.advanceMs(60_000);
    const fourth = makeRun({
      id: 'id-4',
      runId: 'run-4',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      errorCode: 'INTERNAL_ERROR',
      errorSummary: 'still broken',
    });
    runs.add(fourth);
    const deduped = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: fourth,
      operationId: 'op-4',
    });
    expect(deduped.kind).toBe('deduped');
    expect(messages).toHaveLength(1);
    expect([...alerts.rows.values()][0]?.metadata.consecutiveFailureCount).toBe(4);
    expect([...alerts.rows.values()][0]?.metadata.latestErrorCode).toBe('INTERNAL_ERROR');

    // policy refusal neither counts nor resolves
    clock.advanceMs(60_000);
    const refusal = makeRun({
      id: 'id-5',
      runId: 'run-5',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      errorCode: 'FUNDING_DISABLED',
      errorSummary: 'kill switch',
    });
    runs.add(refusal);
    const skipped = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: refusal,
      operationId: 'op-5',
    });
    expect(skipped).toEqual({ kind: 'skipped', reason: 'policy-refusal' });
    expect(alerts.rows.size).toBe(1);
    expect(messages).toHaveLength(1);

    // success → resolve (no recovery email)
    clock.advanceMs(60_000);
    const success = makeRun({
      id: 'id-6',
      runId: 'run-6',
      startedAt: clock.now(),
      finishedAt: clock.now(),
    });
    runs.add(success);
    const resolved = await maybeNotifyReconciliationFailure(deps, {
      ...base,
      run: success,
      operationId: 'op-6',
    });
    expect(resolved).toEqual({ kind: 'resolved', alertId: 'alert-1' });
    expect(alerts.rows.size).toBe(0);
    expect(alerts.resolved).toHaveLength(1);
    expect(messages).toHaveLength(1);
    const resolveAudit = vi.mocked(auditEvents.record).mock.calls.find((call) => {
      const payload = call[0];
      return payload.action === 'treasury.alert.resolved';
    });
    expect(resolveAudit?.[0]?.metadata).toMatchObject({ reason: 'reconciliation-recovered' });
  });

  it('leaves pendingEmail set when email fails and does not throw', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('fail');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-08-01T12:00:00.000Z'));
    const failingRun = makeRun({
      id: 'id-1',
      runId: 'run-1',
      errorCode: 'SIGNER_UNAVAILABLE',
      errorSummary: 'x',
    });
    const runs = createRunRepo([
      makeRun({
        id: 'id-0',
        runId: 'run-0',
        startedAt: new Date('2026-08-01T11:58:00.000Z'),
        finishedAt: new Date('2026-08-01T11:59:00.000Z'),
        errorCode: 'SIGNER_UNAVAILABLE',
        errorSummary: 'x',
      }),
      failingRun,
    ]);

    const result = await maybeNotifyReconciliationFailure(
      {
        alerts,
        reconciliationRuns: runs,
        managedWallets: createManagedWallets(),
        emailSender: sender,
        auditEvents,
        clock,
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      },
      {
        run: failingRun,
        treasury,
        failureAlertThreshold: 2,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'test',
        operationId: 'op-1',
        actor: { type: 'cron', id: 'cred-1' },
      },
    );

    expect(result).toEqual({ kind: 'opened', alertId: 'alert-1', email: 'failed' });
    expect(messages).toHaveLength(1);
    const stored = [...alerts.rows.values()][0];
    expect(stored?.pendingEmail).toBe('critical');
    expect(stored?.lastSentAt).toBeUndefined();
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'treasury.alert.email.failed' }),
    );
  });

  it('coexists with a balance alert on the same treasury', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const clock = createClock(new Date('2026-08-01T12:00:00.000Z'));
    await alerts.insertOpen({
      alertType: TREASURY_BALANCE_ALERT_TYPE,
      severity: 'warning',
      entityType: 'treasury',
      entityId: treasury.id,
      firstTriggeredAt: clock.now(),
      lastEvaluatedAt: clock.now(),
      pendingEmail: 'warning',
      metadata: {},
    });

    const run = makeRun({
      id: 'id-1',
      runId: 'run-1',
      errorCode: 'INTERNAL_ERROR',
      errorSummary: 'x',
    });
    const result = await maybeNotifyReconciliationFailure(
      {
        alerts,
        reconciliationRuns: createRunRepo([run]),
        managedWallets: createManagedWallets(),
        emailSender: sender,
        auditEvents: { record: () => Promise.resolve() },
        clock,
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      },
      {
        run,
        treasury,
        failureAlertThreshold: 1,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'test',
        operationId: 'op-1',
        actor: { type: 'cron', id: 'cred-1' },
      },
    );

    expect(result.kind).toBe('opened');
    expect(messages).toHaveLength(1);
    expect(alerts.rows.size).toBe(2);
    expect(await alerts.findOpenByEntity('treasury', treasury.id, TREASURY_BALANCE_ALERT_TYPE)).toBeDefined();
    expect(
      await alerts.findOpenByEntity('treasury', treasury.id, RECONCILIATION_FAILURE_ALERT_TYPE),
    ).toBeDefined();
  });
});
