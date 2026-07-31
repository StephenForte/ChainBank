import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  notifyTreasuryReserveRefusal,
  resolveTreasuryReserveAlert,
  TREASURY_BALANCE_ALERT_TYPE,
  TREASURY_RESERVE_ALERT_TYPE,
} from '../../src/app/alerts/notify-treasury-reserve-alert.js';
import type { EmailMessage, EmailSender } from '../../src/app/ports.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
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

describe.skipIf(!integrationEnabled)('treasury reserve alert lifecycle', () => {
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

  it('opens on first refusal, dedupes repeats, and resolves without deleting the row', async () => {
    const alerts = createAlertRepository(handle.db);
    const auditEvents = createAuditEventRepository(handle.db);
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };
    const clock = createFixedClock(new Date('2026-07-31T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }
    const deps = { alerts, emailSender, auditEvents, clock, logger };
    const input = {
      treasury,
      treasuryBalanceWei: 200_000_000_000_000_000n,
      managedWalletAddressDisplay: '0x2222222222222222222222222222222222222222',
      managedWalletId: seed.managedWalletId,
      requestedAmountWei: 500_000_000_000_000_000n,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      actor: { type: 'api_credential' as const, id: 'cred-1' },
    };

    const opened = await notifyTreasuryReserveRefusal(deps, { ...input, operationId: 'op-1' });
    expect(opened.kind).toBe('opened');
    expect(messages).toHaveLength(1);

    const openAfterFirst = await alerts.findOpenByEntity(
      'treasury',
      seed.treasuryId,
      TREASURY_RESERVE_ALERT_TYPE,
    );
    expect(openAfterFirst?.severity).toBe('critical');
    expect(openAfterFirst?.lastSentAt).toBeDefined();
    expect(openAfterFirst?.pendingEmail).toBeUndefined();
    const alertId = openAfterFirst?.id;
    expect(alertId).toBeDefined();

    clock.advance(60_000);
    const deduped = await notifyTreasuryReserveRefusal(deps, {
      ...input,
      operationId: 'op-2',
      managedWalletId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestedAmountWei: 250_000_000_000_000_000n,
    });
    expect(deduped.kind).toBe('deduped');
    expect(messages).toHaveLength(1);

    const openAfterRepeat = await alerts.findOpenByEntity(
      'treasury',
      seed.treasuryId,
      TREASURY_RESERVE_ALERT_TYPE,
    );
    expect(openAfterRepeat?.id).toBe(alertId);
    expect(openAfterRepeat?.lastEvaluatedAt.getTime()).toBeGreaterThan(
      openAfterFirst!.lastEvaluatedAt.getTime(),
    );
    expect(openAfterRepeat?.metadata.requestedAmountWei).toBe('250000000000000000');

    // Coexistence with a balance alert must not collide.
    await alerts.insertOpen({
      alertType: TREASURY_BALANCE_ALERT_TYPE,
      severity: 'warning',
      entityType: 'treasury',
      entityId: seed.treasuryId,
      firstTriggeredAt: clock.now(),
      lastEvaluatedAt: clock.now(),
      pendingEmail: 'warning',
      metadata: {},
    });

    clock.advance(60_000);
    const resolved = await resolveTreasuryReserveAlert(
      { alerts, auditEvents, clock },
      {
        treasuryId: seed.treasuryId,
        operationId: 'op-success',
        actor: { type: 'api_credential', id: 'cred-1' },
      },
    );
    expect(resolved.kind).toBe('resolved');

    expect(await alerts.findOpenByEntity('treasury', seed.treasuryId, TREASURY_RESERVE_ALERT_TYPE)).toBeUndefined();
    expect(
      await alerts.findOpenByEntity('treasury', seed.treasuryId, TREASURY_BALANCE_ALERT_TYPE),
    ).toBeDefined();

    const row = await handle.pool.query<{ state: string; has_resolved: boolean }>(
      `SELECT state, resolved_at IS NOT NULL AS has_resolved FROM alerts WHERE id = $1`,
      [alertId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.state).toBe('resolved');
    expect(row.rows[0]?.has_resolved).toBe(true);
  });

  it('leaves pendingEmail set when the provider rejects so the next refusal retries', async () => {
    const alerts = createAlertRepository(handle.db);
    const auditEvents = createAuditEventRepository(handle.db);
    let fail = true;
    const emailSender: EmailSender = {
      send() {
        if (fail) {
          return Promise.resolve({
            kind: 'failed',
            errorCode: 'EMAIL_PROVIDER_UNAVAILABLE',
            reason: 'simulated',
          });
        }
        return Promise.resolve({ kind: 'sent', providerMessageId: 'ok' });
      },
    };
    const clock = createFixedClock(new Date('2026-07-31T12:00:00.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });
    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }
    const deps = { alerts, emailSender, auditEvents, clock, logger };
    const input = {
      treasury,
      treasuryBalanceWei: 200_000_000_000_000_000n,
      managedWalletAddressDisplay: '0x2222222222222222222222222222222222222222',
      managedWalletId: seed.managedWalletId,
      requestedAmountWei: 500_000_000_000_000_000n,
      operatorRecipients: ['operator@example.com'] as const,
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      actor: { type: 'api_credential' as const, id: 'cred-1' },
    };

    await notifyTreasuryReserveRefusal(deps, { ...input, operationId: 'op-1' });
    const afterFail = await alerts.findOpenByEntity('treasury', seed.treasuryId, TREASURY_RESERVE_ALERT_TYPE);
    expect(afterFail?.lastSentAt).toBeUndefined();
    expect(afterFail?.pendingEmail).toBe('critical');

    fail = false;
    clock.advance(1_000);
    const retried = await notifyTreasuryReserveRefusal(deps, { ...input, operationId: 'op-2' });
    expect(retried).toMatchObject({ kind: 'retried', email: 'sent' });
    const afterRetry = await alerts.findOpenByEntity('treasury', seed.treasuryId, TREASURY_RESERVE_ALERT_TYPE);
    expect(afterRetry?.lastSentAt).toBeDefined();
    expect(afterRetry?.pendingEmail).toBeUndefined();
  });
});
