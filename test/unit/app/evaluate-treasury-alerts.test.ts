import { describe, expect, it, vi } from 'vitest';
import {
  evaluateTreasuryAlerts,
  TREASURY_BALANCE_ALERT_TYPE,
  TREASURY_ALERT_ENTITY_TYPE,
} from '../../../src/app/alerts/evaluate-treasury-alerts.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailMessage,
  EmailSender,
  PendingAlertEmail,
  StoredOpenAlert,
  Treasury,
} from '../../../src/app/ports.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';

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
    criticalBalanceWei: parseEtherToWei('0.25', 'c'),
    warningBalanceWei: parseEtherToWei('1', 'w'),
    recoveryBalanceWei: parseEtherToWei('2', 'r'),
    minimumReserveWei: parseEtherToWei('0.5', 'm'),
  },
  status: 'warning',
  lastObservedBalanceWei: parseEtherToWei('0.5', 'b'),
  lastObservedAt: new Date('2026-07-29T12:00:00.000Z'),
  lastCheckedAt: new Date('2026-07-29T12:00:00.000Z'),
  lastCheckErrorCode: undefined,
  enabled: true,
};

const REMINDER_MS = 24 * 60 * 60 * 1000;

function createFakeAlerts(): AlertRepository & { readonly rows: Map<string, StoredOpenAlert> } {
  const rows = new Map<string, StoredOpenAlert>();
  let seq = 0;

  return {
    rows,
    async findOpenByEntity(entityType, entityId) {
      return Promise.resolve(
        [...rows.values()].find((row) => row.entityType === entityType && row.entityId === entityId),
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
        metadata: { ...existing.metadata, pendingEmail: input.pendingEmail },
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
      return Promise.resolve({
        ...existing,
        pendingEmail: undefined,
        lastEvaluatedAt: input.lastEvaluatedAt,
      });
    },
    async touchLastEvaluated(input) {
      const existing = rows.get(input.id);
      if (existing === undefined) {
        return Promise.resolve();
      }
      rows.set(input.id, { ...existing, lastEvaluatedAt: input.lastEvaluatedAt });
      return Promise.resolve();
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

describe('evaluateTreasuryAlerts', () => {
  it('opens a warning alert and sends exactly one warning email', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    const result = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      {
        treasury,
        balanceWei: parseEtherToWei('0.5', 'b'),
        reminderIntervalMs: REMINDER_MS,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'local',
        operationId: 'op-1',
        actor: { type: 'cron', id: 'treasury-monitor' },
      },
    );

    expect(result.transition).toEqual({ kind: 'open', severity: 'warning' });
    expect(result.email.kind).toBe('sent');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toMatch(/WARNING/);
    expect(messages[0]?.text).toContain('http://localhost:3000');
    expect(alerts.rows.size).toBe(1);
    const stored = [...alerts.rows.values()][0];
    expect(stored?.alertType).toBe(TREASURY_BALANCE_ALERT_TYPE);
    expect(stored?.entityType).toBe(TREASURY_ALERT_ENTITY_TYPE);
    expect(stored?.severity).toBe('warning');
    expect(stored?.lastSentAt).toEqual(clock.now());
    expect(stored?.pendingEmail).toBeUndefined();
  });

  it('escalates to critical with exactly one critical email', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      {
        treasury,
        balanceWei: parseEtherToWei('0.5', 'b'),
        reminderIntervalMs: REMINDER_MS,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'local',
        operationId: 'op-1',
        actor: { type: 'cron', id: 'treasury-monitor' },
      },
    );

    clock.advanceMs(60_000);
    const result = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      {
        treasury,
        balanceWei: parseEtherToWei('0.1', 'b'),
        reminderIntervalMs: REMINDER_MS,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'local',
        operationId: 'op-2',
        actor: { type: 'cron', id: 'treasury-monitor' },
      },
    );

    expect(result.transition).toEqual({ kind: 'escalate' });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.subject).toMatch(/CRITICAL/);
    expect([...alerts.rows.values()][0]?.severity).toBe('critical');
  });

  it('sends nothing when the open alert state is unchanged', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    const input = {
      treasury,
      balanceWei: parseEtherToWei('0.5', 'b'),
      reminderIntervalMs: REMINDER_MS,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'local',
      actor: { type: 'cron' as const, id: 'treasury-monitor' },
    };

    await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-1' },
    );
    clock.advanceMs(60_000);
    const result = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-2' },
    );

    expect(result.transition.kind).toBe('none');
    expect(result.email.kind).toBe('not-required');
    expect(messages).toHaveLength(1);
  });

  it('sends a reminder after the configured interval', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    const input = {
      treasury,
      balanceWei: parseEtherToWei('0.5', 'b'),
      reminderIntervalMs: REMINDER_MS,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'local',
      actor: { type: 'cron' as const, id: 'treasury-monitor' },
    };

    await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-1' },
    );
    clock.advanceMs(REMINDER_MS);
    const result = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-2' },
    );

    expect(result.transition.kind).toBe('remind');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.subject).toMatch(/REMINDER/);
  });

  it('resolves on recovery and sends exactly one recovery email', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      {
        treasury,
        balanceWei: parseEtherToWei('0.5', 'b'),
        reminderIntervalMs: REMINDER_MS,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'local',
        operationId: 'op-1',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );

    clock.advanceMs(60_000);
    const result = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      {
        treasury,
        balanceWei: parseEtherToWei('2.5', 'b'),
        reminderIntervalMs: REMINDER_MS,
        operatorRecipients: ['operator@example.com'],
        dashboardBaseUrl: 'http://localhost:3000',
        environment: 'local',
        operationId: 'op-2',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );

    expect(result.transition.kind).toBe('resolve');
    expect(result.email.kind).toBe('sent');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.subject).toMatch(/RECOVERY/);
    expect(alerts.rows.size).toBe(0);
    expect(result.openAlert).toBeUndefined();
  });

  it('retries the same email when send fails without advancing last_sent_at', async () => {
    const alerts = createFakeAlerts();
    let mode: 'sent' | 'fail' = 'fail';
    const { sender, messages } = createSender(() => mode);
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-29T12:00:00.000Z'));

    const input = {
      treasury,
      balanceWei: parseEtherToWei('0.5', 'b'),
      reminderIntervalMs: REMINDER_MS,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'local',
      actor: { type: 'cron' as const, id: 'treasury-monitor' },
    };

    const failed = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-1' },
    );

    expect(failed.email.kind).toBe('failed');
    expect(messages).toHaveLength(1);
    const pending = [...alerts.rows.values()][0];
    expect(pending?.pendingEmail).toBe('warning' satisfies PendingAlertEmail);
    expect(pending?.lastSentAt).toBeUndefined();

    mode = 'sent';
    clock.advanceMs(60_000);
    const retried = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-2' },
    );

    expect(retried.transition).toEqual({ kind: 'open', severity: 'warning' });
    expect(retried.email.kind).toBe('sent');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.subject).toMatch(/WARNING/);
    expect([...alerts.rows.values()][0]?.lastSentAt).toEqual(clock.now());
    expect([...alerts.rows.values()][0]?.pendingEmail).toBeUndefined();

    clock.advanceMs(60_000);
    const stable = await evaluateTreasuryAlerts(
      { alerts, emailSender: sender, auditEvents, clock },
      { ...input, operationId: 'op-3' },
    );
    expect(stable.email.kind).toBe('not-required');
    expect(messages).toHaveLength(2);
  });
});
