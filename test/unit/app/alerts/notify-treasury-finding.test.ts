import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  criticalFindingLogFields,
  logCriticalReconciliationFindings,
  notifyTreasuryFinding,
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
  treasuryFindingAlertEntityId,
} from '../../../../src/app/alerts/notify-treasury-finding.js';
import { TREASURY_BALANCE_ALERT_TYPE } from '../../../../src/app/alerts/evaluate-treasury-alerts.js';
import { classifyReconciliationRun } from '../../../../src/app/alerts/notify-reconciliation-failure.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailMessage,
  EmailSender,
  ReconciliationFinding,
  ReconciliationRun,
  StoredAlert,
  StoredOpenAlert,
  Treasury,
} from '../../../../src/app/ports.js';
import { parseEtherToWei } from '../../../../src/domain/wei.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { classifyReconcilerExit, reconcilerExitCode } from '../../../../src/jobs/wallet-reconciler.js';

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

const TX_HASH_A = `0x${'aa'.repeat(32)}`;
const TX_HASH_B = `0x${'bb'.repeat(32)}`;

function unexplainedFinding(
  overrides: Partial<Extract<ReconciliationFinding, { kind: 'unexplained_outgoing_transfer' }>> = {},
): Extract<ReconciliationFinding, { kind: 'unexplained_outgoing_transfer' }> {
  return {
    kind: 'unexplained_outgoing_transfer',
    severity: 'critical',
    treasuryId: treasury.id,
    transactionHash: TX_HASH_A,
    toAddress: '0x5128123456789012345678901234567890ab652d',
    valueWei: '1000000000000000000',
    nonce: 3,
    blockNumber: '11425869',
    ...overrides,
  };
}

type FakeAlertRow = StoredAlert;

function toOpenView(row: FakeAlertRow): StoredOpenAlert {
  return {
    id: row.id,
    alertType: row.alertType,
    severity: row.severity,
    entityType: row.entityType,
    entityId: row.entityId,
    firstTriggeredAt: row.firstTriggeredAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    lastSentAt: row.lastSentAt,
    pendingEmail: row.pendingEmail,
    metadata: row.metadata,
  };
}

function createFakeAlerts(): AlertRepository & {
  readonly rows: Map<string, FakeAlertRow>;
} {
  const rows = new Map<string, FakeAlertRow>();
  let seq = 0;

  return {
    rows,
    async findOpenByEntity(entityType, entityId, alertType) {
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.state === 'open' &&
          candidate.entityType === entityType &&
          candidate.entityId === entityId &&
          candidate.alertType === alertType,
      );
      return Promise.resolve(row === undefined ? undefined : toOpenView(row));
    },
    async findOpenOrAcknowledgedByEntity(entityType, entityId, alertType) {
      return Promise.resolve(
        [...rows.values()].find(
          (row) =>
            (row.state === 'open' || row.state === 'acknowledged') &&
            row.entityType === entityType &&
            row.entityId === entityId &&
            row.alertType === alertType,
        ),
      );
    },
    async findById(id) {
      return Promise.resolve(rows.get(id));
    },
    async list() {
      return Promise.resolve({ items: [...rows.values()], total: rows.size });
    },
    async insertOpen(input) {
      const id = `alert-${String(++seq)}`;
      const row: FakeAlertRow = {
        id,
        alertType: input.alertType,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
        state: 'open',
        firstTriggeredAt: input.firstTriggeredAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        lastSentAt: undefined,
        resolvedAt: undefined,
        acknowledgedAt: undefined,
        acknowledgedBy: undefined,
        acknowledgementNote: undefined,
        pendingEmail: input.pendingEmail,
        metadata: { ...input.metadata, pendingEmail: input.pendingEmail },
      };
      rows.set(id, row);
      return Promise.resolve(toOpenView(row));
    },
    async markEscalated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      const next: FakeAlertRow = {
        ...existing,
        severity: 'critical',
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: input.pendingEmail,
        metadata: { ...existing.metadata, pendingEmail: input.pendingEmail },
      };
      rows.set(input.id, next);
      return Promise.resolve(toOpenView(next));
    },
    async markPendingEmail(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      const next: FakeAlertRow = {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: input.pendingEmail,
        metadata: {
          ...existing.metadata,
          ...(input.metadata ?? {}),
          pendingEmail: input.pendingEmail,
        },
      };
      rows.set(input.id, next);
      return Promise.resolve(toOpenView(next));
    },
    async clearPendingEmail(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: FakeAlertRow = {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(toOpenView(next));
    },
    async acknowledgeSend(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: FakeAlertRow = {
        ...existing,
        lastSentAt: input.lastSentAt,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(toOpenView(next));
    },
    async recordOperatorAcknowledgement(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      const metadata = { ...existing.metadata };
      delete metadata.pendingEmail;
      const next: FakeAlertRow = {
        ...existing,
        state: 'acknowledged',
        acknowledgedAt: input.acknowledgedAt,
        acknowledgedBy: input.acknowledgedBy,
        acknowledgementNote: input.acknowledgementNote,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
        metadata,
      };
      rows.set(input.id, next);
      return Promise.resolve(next);
    },
    async resolve(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
      }
      rows.delete(input.id);
      return Promise.resolve(toOpenView(existing));
    },
    async touchLastEvaluated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined || existing.state !== 'open') {
        throw new Error('missing');
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

function createAudit(): AuditEventRepository & {
  readonly actions: string[];
} {
  const actions: string[] = [];
  return {
    actions,
    async record(event) {
      actions.push(event.action);
      return Promise.resolve();
    },
  };
}

function collectLogs(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('treasuryFindingAlertEntityId', () => {
  it('keys unexplained transfers on the transaction hash', () => {
    expect(treasuryFindingAlertEntityId(unexplainedFinding())).toBe(TX_HASH_A);
    expect(
      treasuryFindingAlertEntityId(unexplainedFinding({ transactionHash: TX_HASH_A.toUpperCase() })),
    ).toBe(TX_HASH_A);
  });

  it('keys scan-incomplete findings on treasury and error code', () => {
    expect(
      treasuryFindingAlertEntityId({
        kind: 'outgoing_scan_incomplete',
        severity: 'critical',
        treasuryId: treasury.id,
        errorCode: 'RPC_UNAVAILABLE',
        reason: 'tip read failed',
      }),
    ).toBe(`outgoing_scan_incomplete:${treasury.id}:RPC_UNAVAILABLE`);
  });
});

describe('C15 neutrality with critical findings', () => {
  it('classifies a funded-correctly run with a critical finding as success and exit 0', () => {
    const run: Pick<ReconciliationRun, 'finishedAt' | 'errorCode' | 'walletsFunded' | 'walletsFailed'> = {
      finishedAt: new Date('2026-08-05T18:00:20.000Z'),
      errorCode: undefined,
      walletsFunded: 0,
      walletsFailed: 0,
    };

    expect(classifyReconciliationRun(run)).toBe('success');
    expect(classifyReconcilerExit(undefined)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
  });
});

describe('logCriticalReconciliationFindings', () => {
  it('emits error-level logs with the transaction hash and JSON-serializable fields', () => {
    const { stream, lines } = collectLogs();
    const logger = createLogger({
      level: 'error',
      serviceRole: 'test',
      environment: 'test',
      destination: stream,
    });

    const finding = unexplainedFinding();
    logCriticalReconciliationFindings(logger, {
      findings: [
        finding,
        {
          kind: 'wallet_assessment_failed',
          severity: 'warning',
          walletId: 'w1',
          reason: 'ignored',
        },
      ],
      correlationId: 'corr-1',
      runId: 'run-1',
    });

    // Pino may buffer; yield so the destination stream receives the line.
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const criticalLines = lines().filter((line) => line['event'] === 'reconciliation.critical_finding');
        expect(criticalLines).toHaveLength(1);
        expect(criticalLines[0]?.['level']).toBe('error');
        expect(criticalLines[0]?.['transactionHash']).toBe(TX_HASH_A);
        expect(criticalLines[0]?.['valueWei']).toBe('1000000000000000000');
        expect(() => JSON.stringify(criticalFindingLogFields(finding))).not.toThrow();
        expect(() => JSON.stringify(criticalLines[0])).not.toThrow();
        resolve();
      });
    });
  });
});

describe('notifyTreasuryFinding', () => {
  const clock = { now: () => new Date('2026-08-05T18:00:20.000Z') };
  const logger = createLogger({ level: 'silent', serviceRole: 'test', environment: 'test' });

  function baseInput(finding = unexplainedFinding()) {
    return {
      finding,
      treasury,
      runId: 'run-1',
      operatorRecipients: ['ops@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: 'corr-1',
      actor: { type: 'cron' as const, id: 'wallet-reconciler' },
    };
  }

  it('opens and emails a new finding, then dedupes re-observation without re-sending', async () => {
    const alerts = createFakeAlerts();
    const audit = createAudit();
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: 'msg-1' });
      },
    };

    const first = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(),
    );
    expect(first.kind).toBe('opened');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toContain('[CRITICAL]');
    expect(messages[0]?.text).toContain(TX_HASH_A);
    expect(messages[0]?.text).toContain('https://sepolia.etherscan.io/tx/');
    expect(audit.actions).toContain('treasury.alert.email.sent');

    const open = await alerts.findOpenByEntity(
      TREASURY_FINDING_ENTITY_TYPE,
      TX_HASH_A,
      TREASURY_FINDING_ALERT_TYPE,
    );
    expect(open).toBeDefined();
    expect(open?.pendingEmail).toBeUndefined();
    expect(open?.lastSentAt).toBeDefined();

    const second = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(),
    );
    expect(second).toEqual({ kind: 'deduped', alertId: open?.id });
    expect(messages).toHaveLength(1);
  });

  it('alerts a second distinct unexplained transfer while the first alert is still open', async () => {
    const alerts = createFakeAlerts();
    const audit = createAudit();
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };

    const first = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_A })),
    );
    const second = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_B, nonce: 4 })),
    );

    expect(first.kind).toBe('opened');
    expect(second.kind).toBe('opened');
    expect(messages).toHaveLength(2);
    expect(alerts.rows.size).toBe(2);
    expect(
      await alerts.findOpenByEntity(TREASURY_FINDING_ENTITY_TYPE, TX_HASH_A, TREASURY_FINDING_ALERT_TYPE),
    ).toBeDefined();
    expect(
      await alerts.findOpenByEntity(TREASURY_FINDING_ENTITY_TYPE, TX_HASH_B, TREASURY_FINDING_ALERT_TYPE),
    ).toBeDefined();
  });

  it('does not collide with a treasury_balance alert on the same treasury', async () => {
    const alerts = createFakeAlerts();
    await alerts.insertOpen({
      alertType: TREASURY_BALANCE_ALERT_TYPE,
      severity: 'critical',
      entityType: 'treasury',
      entityId: treasury.id,
      firstTriggeredAt: clock.now(),
      lastEvaluatedAt: clock.now(),
      pendingEmail: 'critical',
      metadata: {},
    });

    const emailSender: EmailSender = {
      send: () => Promise.resolve({ kind: 'sent', providerMessageId: 'msg-1' }),
    };
    const result = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: createAudit(), clock, logger },
      baseInput(),
    );
    expect(result.kind).toBe('opened');
    expect(alerts.rows.size).toBe(2);
  });

  it('retries a pending send and records email failure without resolving', async () => {
    const alerts = createFakeAlerts();
    const audit = createAudit();
    const emailSender: EmailSender = {
      send: () =>
        Promise.resolve({
          kind: 'failed' as const,
          errorCode: 'EMAIL_PROVIDER_REJECTED' as const,
          reason: 'provider rejected',
        }),
    };

    const first = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(),
    );
    expect(first).toEqual({ kind: 'opened', alertId: 'alert-1', email: 'failed' });
    expect(audit.actions).toContain('treasury.alert.email.failed');

    const open = await alerts.findOpenByEntity(
      TREASURY_FINDING_ENTITY_TYPE,
      TX_HASH_A,
      TREASURY_FINDING_ALERT_TYPE,
    );
    expect(open?.pendingEmail).toBe('critical');
    expect(open?.lastSentAt).toBeUndefined();

    const retrySender: EmailSender = {
      send: () => Promise.resolve({ kind: 'sent', providerMessageId: 'msg-2' }),
    };
    const retried = await notifyTreasuryFinding(
      { alerts, emailSender: retrySender, auditEvents: audit, clock, logger },
      baseInput(),
    );
    expect(retried.kind).toBe('retried');
    expect(retried).toMatchObject({ email: 'sent' });
  });

  it('leaves the open alert in place — there is no auto-resolution path', async () => {
    const alerts = createFakeAlerts();
    const emailSender: EmailSender = {
      send: () => Promise.resolve({ kind: 'sent', providerMessageId: 'msg-1' }),
    };
    await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: createAudit(), clock, logger },
      baseInput(),
    );

    // Re-observation after send only touches last_evaluated — never resolve().
    const resolveSpy = vi.spyOn(alerts, 'resolve');
    await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: createAudit(), clock, logger },
      baseInput(),
    );
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(
      await alerts.findOpenByEntity(TREASURY_FINDING_ENTITY_TYPE, TX_HASH_A, TREASURY_FINDING_ALERT_TYPE),
    ).toBeDefined();
  });

  it('does not re-alert after operator acknowledgement of the same transaction hash (C20)', async () => {
    const alerts = createFakeAlerts();
    const audit = createAudit();
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };

    const opened = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_A })),
    );
    expect(opened.kind).toBe('opened');
    expect(messages).toHaveLength(1);

    await alerts.recordOperatorAcknowledgement({
      id: opened.alertId,
      acknowledgedAt: clock.now(),
      acknowledgedBy: 'operator-cred-1',
      acknowledgementNote: 'Confirmed operator hand-send to HARVEST.',
      lastEvaluatedAt: clock.now(),
    });
    expect(
      await alerts.findOpenByEntity(TREASURY_FINDING_ENTITY_TYPE, TX_HASH_A, TREASURY_FINDING_ALERT_TYPE),
    ).toBeUndefined();
    expect(
      await alerts.findOpenOrAcknowledgedByEntity(
        TREASURY_FINDING_ENTITY_TYPE,
        TX_HASH_A,
        TREASURY_FINDING_ALERT_TYPE,
      ),
    ).toMatchObject({ state: 'acknowledged', id: opened.alertId });

    const reobserved = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: audit, clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_A })),
    );
    expect(reobserved).toEqual({ kind: 'deduped', alertId: opened.alertId });
    expect(messages).toHaveLength(1);
    expect(alerts.rows.size).toBe(1);
  });

  it('still alerts a distinct transfer while another finding is acknowledged (C20)', async () => {
    const alerts = createFakeAlerts();
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };

    const first = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: createAudit(), clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_A })),
    );
    await alerts.recordOperatorAcknowledgement({
      id: first.alertId,
      acknowledgedAt: clock.now(),
      acknowledgedBy: 'operator-cred-1',
      acknowledgementNote: 'A is benign.',
      lastEvaluatedAt: clock.now(),
    });

    const second = await notifyTreasuryFinding(
      { alerts, emailSender, auditEvents: createAudit(), clock, logger },
      baseInput(unexplainedFinding({ transactionHash: TX_HASH_B, nonce: 4 })),
    );
    expect(second.kind).toBe('opened');
    expect(messages).toHaveLength(2);
    expect(alerts.rows.size).toBe(2);
    expect(
      (
        await alerts.findOpenOrAcknowledgedByEntity(
          TREASURY_FINDING_ENTITY_TYPE,
          TX_HASH_A,
          TREASURY_FINDING_ALERT_TYPE,
        )
      )?.state,
    ).toBe('acknowledged');
    expect(
      await alerts.findOpenByEntity(TREASURY_FINDING_ENTITY_TYPE, TX_HASH_B, TREASURY_FINDING_ALERT_TYPE),
    ).toBeDefined();
  });
});
