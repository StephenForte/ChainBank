import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeFinding,
  MAX_FINDING_ENTITY_ID_LENGTH,
} from '../../../../src/app/alerts/acknowledge-finding.js';
import { MAX_ACKNOWLEDGEMENT_NOTE_LENGTH } from '../../../../src/app/alerts/acknowledge-alert.js';
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
const CREATED_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ACTOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENTITY_ID = `0x${'aa'.repeat(32)}`;
const NOW = new Date('2026-08-06T12:00:00.000Z');

function openFindingAlert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: ALERT_ID,
    alertType: TREASURY_FINDING_ALERT_TYPE,
    severity: 'critical',
    entityType: TREASURY_FINDING_ENTITY_TYPE,
    entityId: ENTITY_ID,
    state: 'open',
    firstTriggeredAt: NOW,
    lastEvaluatedAt: NOW,
    lastSentAt: NOW,
    resolvedAt: undefined,
    acknowledgedAt: undefined,
    acknowledgedBy: undefined,
    acknowledgementNote: undefined,
    pendingEmail: 'critical',
    metadata: { transactionHash: ENTITY_ID, findingKind: 'unexplained_outgoing_transfer' },
    ...overrides,
  };
}

function createDeps(
  initial: StoredAlert | undefined,
  options?: {
    readonly auditFails?: boolean;
    readonly insertOpenFailsWithUnique?: boolean;
    readonly emailSender?: { send: ReturnType<typeof vi.fn> };
  },
) {
  const recorded: Array<{ action: string; metadata: Readonly<Record<string, unknown>> }> = [];
  let stored: StoredAlert | undefined = initial;
  let insertOpenCalls = 0;
  const emailSender = options?.emailSender;

  const alerts: AlertRepository = {
    findOpenByEntity: () => Promise.resolve(stored?.state === 'open' ? stored : undefined),
    findOpenOrAcknowledgedByEntity: (_entityType, entityId) => {
      if (stored === undefined) {
        return Promise.resolve(undefined);
      }
      if (stored.entityId.toLowerCase() !== entityId.toLowerCase()) {
        return Promise.resolve(undefined);
      }
      if (stored.state === 'open' || stored.state === 'acknowledged') {
        return Promise.resolve(stored);
      }
      return Promise.resolve(undefined);
    },
    findById: (id) => Promise.resolve(stored?.id === id ? stored : undefined),
    list: () => Promise.resolve({ items: stored === undefined ? [] : [stored], total: stored ? 1 : 0 }),
    insertOpen(input) {
      insertOpenCalls += 1;
      if (options?.insertOpenFailsWithUnique === true) {
        const err = Object.assign(new Error('duplicate key'), { code: '23505' });
        return Promise.reject(err);
      }
      if (stored !== undefined && stored.state === 'open') {
        const err = Object.assign(new Error('duplicate key'), { code: '23505' });
        return Promise.reject(err);
      }
      stored = {
        id: CREATED_ID,
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
      return Promise.resolve(stored);
    },
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
    getInsertOpenCalls: () => insertOpenCalls,
    emailSender,
  };
}

describe('acknowledgeFinding (C20 finding-identity path)', () => {
  it('creates an open row and acknowledges when no alert exists — no email side effect', async () => {
    const emailSender = { send: vi.fn() };
    const { deps, recorded, getStored, getInsertOpenCalls } = createDeps(undefined, { emailSender });

    const result = await acknowledgeFinding(deps, {
      role: 'operator',
      entityId: ENTITY_ID,
      note: '  Confirmed operator hand-send.  ',
      operationId: 'req-create',
      actorId: ACTOR_ID,
      sourceIp: '127.0.0.1',
      metadata: {
        findingKind: 'unexplained_outgoing_transfer',
        transactionHash: ENTITY_ID,
        valueWei: '1000000000000000000',
      },
    });

    expect(getInsertOpenCalls()).toBe(1);
    expect(result.state).toBe('acknowledged');
    expect(result.id).toBe(CREATED_ID);
    expect(result.entityId).toBe(ENTITY_ID);
    expect(result.acknowledgementNote).toBe('Confirmed operator hand-send.');
    expect(getStored()?.state).toBe('acknowledged');
    expect(getStored()?.pendingEmail).toBeUndefined();
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(recorded).toEqual([
      {
        action: 'treasury.alert.acknowledged',
        metadata: {
          alertType: TREASURY_FINDING_ALERT_TYPE,
          entityType: TREASURY_FINDING_ENTITY_TYPE,
          findingEntityId: ENTITY_ID,
          note: 'Confirmed operator hand-send.',
          previousState: 'open',
          nextState: 'acknowledged',
          acknowledgementPath: 'finding-identity',
        },
      },
    ]);
  });

  it('acknowledges an existing open alert rather than creating a second row', async () => {
    const { deps, getStored, getInsertOpenCalls } = createDeps(openFindingAlert());

    const result = await acknowledgeFinding(deps, {
      role: 'operator',
      entityId: ENTITY_ID.toUpperCase(),
      note: 'stand down — known hand-send',
      operationId: 'req-existing',
      actorId: ACTOR_ID,
      sourceIp: undefined,
    });

    expect(getInsertOpenCalls()).toBe(0);
    expect(result.id).toBe(ALERT_ID);
    expect(result.state).toBe('acknowledged');
    expect(getStored()?.id).toBe(ALERT_ID);
  });

  it('adopts the winner on 23505 rather than inserting a second open row', async () => {
    const existing = openFindingAlert();
    // Start with none so we attempt insert; inject unique violation and a
    // concurrent winner via findOpenOrAcknowledged after the throw.
    let stored: StoredAlert | undefined;
    const recorded: Array<{ action: string }> = [];
    let insertCalls = 0;

    const alerts: AlertRepository = {
      findOpenByEntity: () => Promise.resolve(undefined),
      findOpenOrAcknowledgedByEntity: () => {
        // After insert fails, the concurrent winner is visible.
        return Promise.resolve(insertCalls > 0 ? existing : undefined);
      },
      findById: (id) =>
        Promise.resolve(stored?.id === id ? stored : existing.id === id ? existing : undefined),
      list: () => Promise.resolve({ items: [], total: 0 }),
      insertOpen() {
        insertCalls += 1;
        const err = Object.assign(new Error('duplicate key'), { code: '23505' });
        return Promise.reject(err);
      },
      markEscalated: vi.fn(),
      markPendingEmail: vi.fn(),
      clearPendingEmail: vi.fn(),
      acknowledgeSend: vi.fn(),
      recordOperatorAcknowledgement(input) {
        stored = {
          ...existing,
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
      record(event) {
        recorded.push({ action: event.action });
        return Promise.resolve();
      },
    };

    const result = await acknowledgeFinding(
      {
        operatorMutations: createInlineOperatorMutations({ alerts, auditEvents }),
        clock: { now: () => NOW },
      },
      {
        role: 'operator',
        entityId: ENTITY_ID,
        note: 'race adopt',
        operationId: 'req-race',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      },
    );

    expect(insertCalls).toBe(1);
    expect(result.id).toBe(ALERT_ID);
    expect(result.state).toBe('acknowledged');
    expect(recorded).toHaveLength(1);
  });

  it('rolls back the created open row when the audit insert fails (C21)', async () => {
    const { deps, recorded, getStored, getInsertOpenCalls } = createDeps(undefined, {
      auditFails: true,
    });

    await expect(
      acknowledgeFinding(deps, {
        role: 'operator',
        entityId: ENTITY_ID,
        note: 'should not stick',
        operationId: 'req-audit-fail',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toThrow('forced audit failure');

    expect(getInsertOpenCalls()).toBe(1);
    expect(getStored()).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });

  it('refuses when the finding is already acknowledged', async () => {
    const { deps, getInsertOpenCalls, recorded } = createDeps(
      openFindingAlert({ state: 'acknowledged', acknowledgementNote: 'prior' }),
    );

    await expect(
      acknowledgeFinding(deps, {
        role: 'operator',
        entityId: ENTITY_ID,
        note: 'again',
        operationId: 'req-acked',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    expect(getInsertOpenCalls()).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it('denies read-only and refuses empty notes', async () => {
    const { deps, recorded, getStored } = createDeps(undefined);

    await expect(
      acknowledgeFinding(deps, {
        role: 'read-only',
        entityId: ENTITY_ID,
        note: 'nope',
        operationId: 'req-ro',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    for (const note of ['', '   ', '\n\t']) {
      await expect(
        acknowledgeFinding(deps, {
          role: 'operator',
          entityId: ENTITY_ID,
          note,
          operationId: 'req-empty',
          actorId: ACTOR_ID,
          sourceIp: undefined,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }

    await expect(
      acknowledgeFinding(deps, {
        role: 'operator',
        entityId: ENTITY_ID,
        note: 'x'.repeat(MAX_ACKNOWLEDGEMENT_NOTE_LENGTH + 1),
        operationId: 'req-long',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(
      acknowledgeFinding(deps, {
        role: 'operator',
        entityId: '   ',
        note: 'ok note',
        operationId: 'req-entity',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(
      acknowledgeFinding(deps, {
        role: 'operator',
        entityId: 'x'.repeat(MAX_FINDING_ENTITY_ID_LENGTH + 1),
        note: 'ok note',
        operationId: 'req-entity-long',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(getStored()).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });

  it('acknowledges the real open row for a condition key whose errorCode is upper-case', async () => {
    // C18 stores this key case-preserved and the repository matches entity_id
    // exactly. Lowercasing the whole id missed the real row, inserted a second
    // acknowledged row, and left the original alert open behind a 200 response.
    const storedKey = 'outgoing_scan_incomplete:11111111-1111-4111-8111-111111111111:RPC_UNAVAILABLE';
    const existing = openFindingAlert({ entityId: storedKey });
    let acknowledged: StoredAlert | undefined;
    let insertCalls = 0;

    const alerts: AlertRepository = {
      findOpenByEntity: () => Promise.resolve(undefined),
      // Exact match — faithful to eq(alerts.entityId, entityId).
      findOpenOrAcknowledgedByEntity: (_entityType, entityId) =>
        Promise.resolve(entityId === storedKey ? (acknowledged ?? existing) : undefined),
      findById: () => Promise.resolve(acknowledged ?? existing),
      list: () => Promise.resolve({ items: [], total: 0 }),
      insertOpen: () => {
        insertCalls += 1;
        return Promise.reject(new Error('insertOpen must not be called — the real row exists'));
      },
      markEscalated: vi.fn(),
      markPendingEmail: vi.fn(),
      clearPendingEmail: vi.fn(),
      acknowledgeSend: vi.fn(),
      recordOperatorAcknowledgement: (input) => {
        acknowledged = {
          ...existing,
          state: 'acknowledged',
          acknowledgedAt: input.acknowledgedAt,
          acknowledgedBy: input.acknowledgedBy,
          acknowledgementNote: input.acknowledgementNote,
          lastEvaluatedAt: input.lastEvaluatedAt,
          pendingEmail: undefined,
        };
        return Promise.resolve(acknowledged);
      },
      resolve: vi.fn(),
      touchLastEvaluated: vi.fn(),
    };

    const auditEvents: AuditEventRepository = { record: () => Promise.resolve() };

    const result = await acknowledgeFinding(
      {
        operatorMutations: createInlineOperatorMutations({ alerts, auditEvents }),
        clock: { now: () => NOW },
      },
      {
        role: 'operator',
        entityId: storedKey,
        note: 'RPC outage, aware',
        operationId: 'req-case',
        actorId: ACTOR_ID,
        sourceIp: undefined,
      },
    );

    expect(insertCalls).toBe(0);
    expect(result.id).toBe(ALERT_ID);
    expect(result.state).toBe('acknowledged');
  });
});
