import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeAlert,
  MAX_ACKNOWLEDGEMENT_NOTE_LENGTH,
} from '../../../../src/app/alerts/acknowledge-alert.js';
import {
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
} from '../../../../src/app/alerts/notify-treasury-finding.js';
import type {
  AlertRepository,
  AuditEventRepository,
  OperatorMutationTransaction,
  StoredAlert,
} from '../../../../src/app/ports.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { createInlineOperatorMutations } from '../../../support/operator-mutations.js';

const ALERT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACTOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-06T12:00:00.000Z');

function openFindingAlert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: ALERT_ID,
    alertType: TREASURY_FINDING_ALERT_TYPE,
    severity: 'critical',
    entityType: TREASURY_FINDING_ENTITY_TYPE,
    entityId: `0x${'aa'.repeat(32)}`,
    state: 'open',
    firstTriggeredAt: NOW,
    lastEvaluatedAt: NOW,
    lastSentAt: NOW,
    resolvedAt: undefined,
    acknowledgedAt: undefined,
    acknowledgedBy: undefined,
    acknowledgementNote: undefined,
    pendingEmail: undefined,
    metadata: { transactionHash: `0x${'aa'.repeat(32)}` },
    ...overrides,
  };
}

function createDeps(existing: StoredAlert | undefined, options?: { readonly auditFails?: boolean }) {
  const recorded: Array<{ action: string; metadata: Readonly<Record<string, unknown>> }> = [];
  let stored: StoredAlert | undefined = existing;

  const alerts: AlertRepository = {
    findOpenByEntity: () => Promise.resolve(undefined),
    findOpenOrAcknowledgedByEntity: () => Promise.resolve(undefined),
    findById: (id) => Promise.resolve(stored?.id === id ? stored : undefined),
    list: () => Promise.resolve({ items: stored === undefined ? [] : [stored], total: stored ? 1 : 0 }),
    insertOpen: vi.fn(),
    markEscalated: vi.fn(),
    markPendingEmail: vi.fn(),
    clearPendingEmail: vi.fn(),
    acknowledgeSend: vi.fn(),
    recordOperatorAcknowledgement(input) {
      if (stored === undefined || stored.id !== input.id || stored.state !== 'open') {
        return Promise.reject(new ChainBankError('INVALID_STATUS_TRANSITION', 'not open'));
      }
      stored = {
        ...stored,
        state: 'acknowledged',
        acknowledgedAt: input.acknowledgedAt,
        acknowledgedBy: input.acknowledgedBy,
        acknowledgementNote: input.acknowledgementNote,
        lastEvaluatedAt: input.lastEvaluatedAt,
        pendingEmail: undefined,
      };
      return Promise.resolve(stored);
    },
    resolve: vi.fn(),
    touchLastEvaluated: vi.fn(),
  };

  const auditEvents: AuditEventRepository = {
    async record(event) {
      if (options?.auditFails === true) {
        throw new Error('forced audit failure');
      }
      recorded.push({ action: event.action, metadata: event.metadata });
      return Promise.resolve();
    },
  };

  const inline = createInlineOperatorMutations({ alerts, auditEvents });
  // Simulate transactional rollback: restore alert state when the UoW callback throws.
  const operatorMutations: OperatorMutationTransaction = {
    async run(work) {
      const snapshot = stored === undefined ? undefined : { ...stored };
      try {
        return await inline.run(work);
      } catch (error) {
        stored = snapshot;
        throw error;
      }
    },
  };

  return {
    deps: {
      operatorMutations,
      clock: { now: () => NOW },
    },
    recorded,
    getStored: () => stored,
  };
}

describe('acknowledgeAlert (C20)', () => {
  it('acknowledges an open treasury_finding with a note and writes an audit event', async () => {
    const { deps, recorded, getStored } = createDeps(openFindingAlert());
    const result = await acknowledgeAlert(deps, {
      role: 'operator',
      alertId: ALERT_ID,
      note: '  Confirmed operator hand-send to HARVEST.  ',
      operationId: 'req-1',
      actorId: ACTOR_ID,
      sourceIp: '127.0.0.1',
    });

    expect(result.state).toBe('acknowledged');
    expect(result.acknowledgementNote).toBe('Confirmed operator hand-send to HARVEST.');
    expect(result.acknowledgedBy).toBe(ACTOR_ID);
    expect(result.acknowledgedAt).toEqual(NOW);
    expect(getStored()?.state).toBe('acknowledged');
    expect(recorded).toEqual([
      {
        action: 'treasury.alert.acknowledged',
        metadata: {
          alertType: TREASURY_FINDING_ALERT_TYPE,
          entityType: TREASURY_FINDING_ENTITY_TYPE,
          findingEntityId: `0x${'aa'.repeat(32)}`,
          note: 'Confirmed operator hand-send to HARVEST.',
          previousState: 'open',
          nextState: 'acknowledged',
        },
      },
    ]);
  });

  it('rolls back acknowledgement when the audit insert fails (C21)', async () => {
    const { deps, recorded, getStored } = createDeps(openFindingAlert(), { auditFails: true });

    await expect(
      acknowledgeAlert(deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'should not stick',
        operationId: 'req-audit-fail',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toThrow('forced audit failure');

    expect(getStored()?.state).toBe('open');
    expect(recorded).toHaveLength(0);

    // Retry succeeds once audit is healthy again — the operator bug report scenario.
    const retry = createDeps(getStored());
    const result = await acknowledgeAlert(retry.deps, {
      role: 'operator',
      alertId: ALERT_ID,
      note: 'retry after audit recovered',
      operationId: 'req-retry',
      actorId: ACTOR_ID,
      sourceIp: undefined,
    });
    expect(result.state).toBe('acknowledged');
    expect(retry.recorded).toHaveLength(1);
  });

  it('writes no audit entry when the acknowledgement mutation fails (C21)', async () => {
    const { deps, recorded, getStored } = createDeps(openFindingAlert({ state: 'acknowledged' }));

    await expect(
      acknowledgeAlert(deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'already done',
        operationId: 'req-no-audit',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    expect(getStored()?.state).toBe('acknowledged');
    expect(recorded).toHaveLength(0);
  });

  it('rejects empty, whitespace-only, and oversized notes without state change', async () => {
    const { deps, recorded, getStored } = createDeps(openFindingAlert());

    for (const note of ['', '   ', '\n\t']) {
      await expect(
        acknowledgeAlert(deps, {
          role: 'operator',
          alertId: ALERT_ID,
          note,
          operationId: 'req-empty',
          actorId: ACTOR_ID,
          sourceIp: undefined,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }

    await expect(
      acknowledgeAlert(deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'x'.repeat(MAX_ACKNOWLEDGEMENT_NOTE_LENGTH + 1),
        operationId: 'req-long',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(getStored()?.state).toBe('open');
    expect(recorded).toHaveLength(0);
  });

  it('denies read-only specifically for alert:acknowledge', async () => {
    const { deps, recorded, getStored } = createDeps(openFindingAlert());
    await expect(
      acknowledgeAlert(deps, {
        role: 'read-only',
        alertId: ALERT_ID,
        note: 'should not work',
        operationId: 'req-ro',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(getStored()?.state).toBe('open');
    expect(recorded).toHaveLength(0);
  });

  it('refuses non-finding alert types and non-open states', async () => {
    const balance = createDeps(
      openFindingAlert({ alertType: 'treasury_balance', entityType: 'treasury', entityId: 't1' }),
    );
    await expect(
      acknowledgeAlert(balance.deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'nope',
        operationId: 'req-type',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    const already = createDeps(openFindingAlert({ state: 'acknowledged' }));
    await expect(
      acknowledgeAlert(already.deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'again',
        operationId: 'req-ack',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('returns ALERT_NOT_FOUND when the id does not exist', async () => {
    const { deps } = createDeps(undefined);
    await expect(
      acknowledgeAlert(deps, {
        role: 'operator',
        alertId: ALERT_ID,
        note: 'missing',
        operationId: 'req-miss',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'ALERT_NOT_FOUND' });
  });
});
