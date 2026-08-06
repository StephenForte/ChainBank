import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

describe.skipIf(!integrationEnabled)('AlertRepository', () => {
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

  it('inserts an open alert, finds it by entity, and does not advance last_sent_at until acknowledge', async () => {
    const alerts = createAlertRepository(handle.db);
    const now = new Date('2026-07-29T12:00:00.000Z');

    const created = await alerts.insertOpen({
      alertType: 'treasury_balance',
      severity: 'warning',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      firstTriggeredAt: now,
      lastEvaluatedAt: now,
      pendingEmail: 'warning',
      metadata: { balanceWei: '500000000000000000' },
    });

    expect(created.lastSentAt).toBeUndefined();
    expect(created.pendingEmail).toBe('warning');

    const found = await alerts.findOpenByEntity('treasury', seed.treasuryId, 'treasury_balance');
    expect(found?.id).toBe(created.id);
    expect(found?.severity).toBe('warning');
    expect(found?.pendingEmail).toBe('warning');

    const sentAt = new Date('2026-07-29T12:01:00.000Z');
    const acknowledged = await alerts.acknowledgeSend({
      id: created.id,
      lastSentAt: sentAt,
      lastEvaluatedAt: sentAt,
    });
    expect(acknowledged.lastSentAt).toEqual(sentAt);
    expect(acknowledged.pendingEmail).toBeUndefined();
  });

  it('escalates severity, reminds via pending email, and resolves without deleting', async () => {
    const alerts = createAlertRepository(handle.db);
    const t0 = new Date('2026-07-29T12:00:00.000Z');
    const created = await alerts.insertOpen({
      alertType: 'treasury_balance',
      severity: 'warning',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      firstTriggeredAt: t0,
      lastEvaluatedAt: t0,
      pendingEmail: 'warning',
      metadata: {},
    });
    await alerts.acknowledgeSend({
      id: created.id,
      lastSentAt: t0,
      lastEvaluatedAt: t0,
    });

    const t1 = new Date('2026-07-29T13:00:00.000Z');
    const escalated = await alerts.markEscalated({
      id: created.id,
      lastEvaluatedAt: t1,
      pendingEmail: 'critical',
    });
    expect(escalated.severity).toBe('critical');
    expect(escalated.lastSentAt).toEqual(t0);
    expect(escalated.pendingEmail).toBe('critical');

    await alerts.acknowledgeSend({ id: created.id, lastSentAt: t1, lastEvaluatedAt: t1 });

    const t2 = new Date('2026-07-30T13:00:00.000Z');
    const reminded = await alerts.markPendingEmail({
      id: created.id,
      lastEvaluatedAt: t2,
      pendingEmail: 'reminder',
    });
    expect(reminded.pendingEmail).toBe('reminder');
    expect(reminded.lastSentAt).toEqual(t1);

    await alerts.acknowledgeSend({ id: created.id, lastSentAt: t2, lastEvaluatedAt: t2 });

    const t3 = new Date('2026-07-30T14:00:00.000Z');
    await alerts.markPendingEmail({
      id: created.id,
      lastEvaluatedAt: t3,
      pendingEmail: 'recovery',
    });
    const resolved = await alerts.resolve({
      id: created.id,
      resolvedAt: t3,
      lastEvaluatedAt: t3,
    });
    expect(resolved.pendingEmail).toBeUndefined();

    const open = await alerts.findOpenByEntity('treasury', seed.treasuryId, 'treasury_balance');
    expect(open).toBeUndefined();

    const result = await handle.pool.query<{ state: string; has_resolved: boolean }>(
      `SELECT state, resolved_at IS NOT NULL AS has_resolved FROM alerts WHERE id = $1`,
      [created.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.state).toBe('resolved');
    expect(result.rows[0]?.has_resolved).toBe(true);
  });

  it('finds open alerts by type when multiple types share an entity', async () => {
    const alerts = createAlertRepository(handle.db);
    const earlier = new Date('2026-07-29T12:00:00.000Z');
    const later = new Date('2026-07-29T13:00:00.000Z');

    const balance = await alerts.insertOpen({
      alertType: 'treasury_balance',
      severity: 'warning',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      firstTriggeredAt: earlier,
      lastEvaluatedAt: earlier,
      pendingEmail: 'warning',
      metadata: {},
    });
    const reserve = await alerts.insertOpen({
      alertType: 'treasury_reserve',
      severity: 'critical',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      firstTriggeredAt: later,
      lastEvaluatedAt: later,
      pendingEmail: 'critical',
      metadata: {},
    });

    const foundBalance = await alerts.findOpenByEntity('treasury', seed.treasuryId, 'treasury_balance');
    const foundReserve = await alerts.findOpenByEntity('treasury', seed.treasuryId, 'treasury_reserve');

    expect(foundBalance?.id).toBe(balance.id);
    expect(foundBalance?.alertType).toBe('treasury_balance');
    expect(foundReserve?.id).toBe(reserve.id);
    expect(foundReserve?.alertType).toBe('treasury_reserve');
    expect(foundBalance?.id).not.toBe(foundReserve?.id);
  });

  it('findOpenOrAcknowledgedByEntity prefers open over acknowledged for a shared entityId (C20)', async () => {
    const alerts = createAlertRepository(handle.db);
    const earlier = new Date('2026-08-05T12:00:00.000Z');
    const later = new Date('2026-08-06T12:00:00.000Z');
    const entityId = 'outgoing_scan_incomplete:treasury:RPC_UNAVAILABLE';

    const first = await alerts.insertOpen({
      alertType: 'treasury_finding',
      severity: 'critical',
      entityType: 'treasury_finding',
      entityId,
      firstTriggeredAt: earlier,
      lastEvaluatedAt: earlier,
      pendingEmail: 'critical',
      metadata: {},
    });
    await alerts.acknowledgeSend({
      id: first.id,
      lastSentAt: earlier,
      lastEvaluatedAt: earlier,
    });
    await alerts.recordOperatorAcknowledgement({
      id: first.id,
      acknowledgedAt: earlier,
      acknowledgedBy: 'operator-1',
      acknowledgementNote: 'aware of outage',
      lastEvaluatedAt: earlier,
    });

    const second = await alerts.insertOpen({
      alertType: 'treasury_finding',
      severity: 'critical',
      entityType: 'treasury_finding',
      entityId,
      firstTriggeredAt: later,
      lastEvaluatedAt: later,
      pendingEmail: 'critical',
      metadata: {},
    });

    const preferred = await alerts.findOpenOrAcknowledgedByEntity(
      'treasury_finding',
      entityId,
      'treasury_finding',
    );
    expect(preferred?.id).toBe(second.id);
    expect(preferred?.state).toBe('open');

    const prior = await alerts.findById(first.id);
    expect(prior?.state).toBe('acknowledged');
    expect(prior?.acknowledgementNote).toBe('aware of outage');
  });
});
