import { describe, expect, it, vi } from 'vitest';
import {
  notifyTreasuryReserveRefusal,
  resolveTreasuryReserveAlert,
  TREASURY_BALANCE_ALERT_TYPE,
  TREASURY_RESERVE_ALERT_TYPE,
} from '../../../../src/app/alerts/notify-treasury-reserve-alert.js';
import { provisionalTopUpAmountWei } from '../../../../src/app/funding/dispatch-funding.js';
import type {
  AlertRepository,
  AuditEventRepository,
  EmailMessage,
  EmailSender,
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
  status: 'warning',
  lastObservedBalanceWei: parseEtherToWei('0.2', 'b'),
  lastObservedAt: new Date('2026-07-31T12:00:00.000Z'),
  lastCheckedAt: new Date('2026-07-31T12:00:00.000Z'),
  lastCheckErrorCode: undefined,
  lastOutgoingScanBlock: undefined,
  lastOutgoingScanAt: undefined,
  enabled: true,
};

const REQUESTED = parseEtherToWei('0.5', 'req');
const WALLET_DISPLAY = '0x2222222222222222222222222222222222222222';

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

function baseInput(overrides: Partial<Parameters<typeof notifyTreasuryReserveRefusal>[1]> = {}) {
  return {
    treasury,
    treasuryBalanceWei: parseEtherToWei('0.2', 'b'),
    managedWalletAddressDisplay: WALLET_DISPLAY,
    managedWalletId: '44444444-4444-4444-8444-444444444444',
    requestedAmountWei: REQUESTED,
    operatorRecipients: ['operator@example.com'] as const,
    dashboardBaseUrl: 'http://localhost:3000',
    environment: 'local',
    operationId: 'op-1',
    actor: { type: 'api_credential' as const, id: 'cred-1' },
    ...overrides,
  };
}

describe('notifyTreasuryReserveRefusal', () => {
  it('opens a critical reserve alert and sends exactly one email on first refusal', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));

    const result = await notifyTreasuryReserveRefusal(
      {
        alerts,
        emailSender: sender,
        auditEvents,
        clock,
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      },
      baseInput(),
    );

    expect(result).toEqual({ kind: 'opened', alertId: 'alert-1', email: 'sent' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toMatch(/RESERVE/);
    expect(messages[0]?.text).toContain(WALLET_DISPLAY);
    expect(messages[0]?.text).toContain('0.5 ETH');
    const stored = [...alerts.rows.values()][0];
    expect(stored?.alertType).toBe(TREASURY_RESERVE_ALERT_TYPE);
    expect(stored?.severity).toBe('critical');
    expect(stored?.lastSentAt).toEqual(clock.now());
    expect(stored?.pendingEmail).toBeUndefined();
    expect(stored?.metadata.requestedAmountWei).toBe(REQUESTED.toString());
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'treasury.alert.email.sent' }),
    );
  });

  it('does not send again on repeated refusals; updates last_evaluated_at and metadata', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));
    const deps = {
      alerts,
      emailSender: sender,
      auditEvents,
      clock,
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    };

    await notifyTreasuryReserveRefusal(deps, baseInput());
    clock.advanceMs(60_000);
    const secondWallet = '0x3333333333333333333333333333333333333333';
    const secondAmount = parseEtherToWei('0.25', 'req2');
    const result = await notifyTreasuryReserveRefusal(
      deps,
      baseInput({
        operationId: 'op-2',
        managedWalletAddressDisplay: secondWallet,
        managedWalletId: '55555555-5555-4555-8555-555555555555',
        requestedAmountWei: secondAmount,
      }),
    );

    expect(result.kind).toBe('deduped');
    expect(messages).toHaveLength(1);
    const stored = [...alerts.rows.values()][0];
    expect(stored?.lastEvaluatedAt).toEqual(clock.now());
    expect(stored?.metadata.requestedAmountWei).toBe(secondAmount.toString());
    expect(stored?.metadata.managedWalletAddressDisplay).toBe(secondWallet);
  });

  it('does not advance last_sent_at on failed send and retries on the next evaluation', async () => {
    const alerts = createFakeAlerts();
    let mode: 'fail' | 'sent' = 'fail';
    const { sender, messages } = createSender(() => mode);
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));
    const deps = {
      alerts,
      emailSender: sender,
      auditEvents,
      clock,
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    };

    const first = await notifyTreasuryReserveRefusal(deps, baseInput());
    expect(first).toEqual({ kind: 'opened', alertId: 'alert-1', email: 'failed' });
    const afterFail = [...alerts.rows.values()][0];
    expect(afterFail?.lastSentAt).toBeUndefined();
    expect(afterFail?.pendingEmail).toBe('critical');
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'treasury.alert.email.failed' }),
    );

    mode = 'sent';
    clock.advanceMs(30_000);
    const second = await notifyTreasuryReserveRefusal(deps, baseInput({ operationId: 'op-2' }));
    expect(second).toEqual({ kind: 'retried', alertId: 'alert-1', email: 'sent' });
    expect(messages).toHaveLength(2);
    const afterRetry = [...alerts.rows.values()][0];
    expect(afterRetry?.lastSentAt).toEqual(clock.now());
    expect(afterRetry?.pendingEmail).toBeUndefined();
  });

  it('resolves an open reserve alert once when funding can be served again', async () => {
    const alerts = createFakeAlerts();
    const { sender } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));
    const deps = {
      alerts,
      emailSender: sender,
      auditEvents,
      clock,
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    };

    await notifyTreasuryReserveRefusal(deps, baseInput());
    clock.advanceMs(60_000);
    const resolved = await resolveTreasuryReserveAlert(
      { alerts, auditEvents, clock },
      {
        treasuryId: treasury.id,
        operationId: 'op-success',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );
    expect(resolved).toEqual({ kind: 'resolved', alertId: 'alert-1' });
    expect(alerts.rows.size).toBe(0);
    expect(alerts.resolved).toHaveLength(1);
    const resolveAudit = vi.mocked(auditEvents.record).mock.calls.find((call) => {
      const payload = call[0];
      return payload.action === 'treasury.alert.resolved';
    });
    expect(resolveAudit?.[0]?.metadata).toMatchObject({ reason: 'funding-submitted' });

    const again = await resolveTreasuryReserveAlert(
      { alerts, auditEvents, clock },
      {
        treasuryId: treasury.id,
        operationId: 'op-success-2',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );
    expect(again).toEqual({ kind: 'none-open' });
    expect(alerts.resolved).toHaveLength(1);
  });

  it('keeps reserve and balance alerts on one treasury from interfering', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));

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
    await alerts.acknowledgeSend({
      id: 'alert-1',
      lastSentAt: clock.now(),
      lastEvaluatedAt: clock.now(),
    });

    clock.advanceMs(1_000);
    const result = await notifyTreasuryReserveRefusal(
      {
        alerts,
        emailSender: sender,
        auditEvents,
        clock,
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      },
      baseInput(),
    );

    expect(result.kind).toBe('opened');
    expect(messages).toHaveLength(1);
    expect(alerts.rows.size).toBe(2);
    const balance = await alerts.findOpenByEntity('treasury', treasury.id, TREASURY_BALANCE_ALERT_TYPE);
    const reserve = await alerts.findOpenByEntity('treasury', treasury.id, TREASURY_RESERVE_ALERT_TYPE);
    expect(balance?.alertType).toBe(TREASURY_BALANCE_ALERT_TYPE);
    expect(reserve?.alertType).toBe(TREASURY_RESERVE_ALERT_TYPE);
    expect(balance?.id).not.toBe(reserve?.id);

    await resolveTreasuryReserveAlert(
      { alerts, auditEvents, clock },
      {
        treasuryId: treasury.id,
        operationId: 'op-success',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );
    expect(await alerts.findOpenByEntity('treasury', treasury.id, TREASURY_BALANCE_ALERT_TYPE)).toBeDefined();
    expect(
      await alerts.findOpenByEntity('treasury', treasury.id, TREASURY_RESERVE_ALERT_TYPE),
    ).toBeUndefined();
  });

  it('uses the clamped deficit as requestedAmountWei (never a misleading zero)', () => {
    const amount = provisionalTopUpAmountWei({
      walletBalanceWei: parseEtherToWei('0.1', 'w'),
      policy: {
        minimumBalanceWei: parseEtherToWei('1', 'min'),
        targetBalanceWei: parseEtherToWei('2', 'tgt'),
        maximumTopUpWei: parseEtherToWei('0.5', 'max'),
        isEnabled: true,
      },
    });
    // deficit 1.9 ETH clamped by max top-up 0.5 ETH
    expect(amount).toBe(parseEtherToWei('0.5', 'max'));
    expect(amount).toBeGreaterThan(0n);
  });

  it('skips opening when requested amount is non-positive', async () => {
    const alerts = createFakeAlerts();
    const { sender, messages } = createSender('sent');
    const auditEvents: AuditEventRepository = { record: vi.fn(() => Promise.resolve()) };
    const clock = createClock(new Date('2026-07-31T12:00:00.000Z'));

    const result = await notifyTreasuryReserveRefusal(
      {
        alerts,
        emailSender: sender,
        auditEvents,
        clock,
        logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      },
      baseInput({ requestedAmountWei: 0n }),
    );

    expect(result).toEqual({ kind: 'skipped', reason: 'non-positive-requested-amount' });
    expect(messages).toHaveLength(0);
    expect(alerts.rows.size).toBe(0);
  });
});
