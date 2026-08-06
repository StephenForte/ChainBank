import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  notifyTreasuryFinding,
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
} from '../../src/app/alerts/notify-treasury-finding.js';
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

describe.skipIf(!integrationEnabled)('treasury finding alert lifecycle (C18)', () => {
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

  it('persists distinct open alerts for two unexplained transfers and dedupes re-observation', async () => {
    const alerts = createAlertRepository(handle.db);
    const auditEvents = createAuditEventRepository(handle.db);
    const messages: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send(message) {
        messages.push(message);
        return Promise.resolve({ kind: 'sent', providerMessageId: `msg-${String(messages.length)}` });
      },
    };
    const clock = createFixedClock(new Date('2026-08-05T18:00:20.000Z'));
    const logger = createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' });

    const treasury = await createTreasuryRepository(handle.db).findById(seed.treasuryId);
    if (treasury === undefined) {
      throw new Error('seed treasury missing');
    }

    const deps = { alerts, emailSender, auditEvents, clock, logger };
    const hashA = `0x${'a1'.repeat(32)}`;
    const hashB = `0x${'b2'.repeat(32)}`;

    const first = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashA,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '1000000000000000000',
        nonce: 3,
        blockNumber: '11425869',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(first.kind).toBe('opened');

    const second = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashB,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '500000000000000000',
        nonce: 4,
        blockNumber: '11425870',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(second.kind).toBe('opened');
    expect(messages).toHaveLength(2);

    const openCount = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
       WHERE alert_type = $1 AND entity_type = $2 AND state = 'open'`,
      [TREASURY_FINDING_ALERT_TYPE, TREASURY_FINDING_ENTITY_TYPE],
    );
    expect(openCount.rows[0]?.count).toBe('2');

    const deduped = await notifyTreasuryFinding(deps, {
      finding: {
        kind: 'unexplained_outgoing_transfer',
        severity: 'critical',
        treasuryId: treasury.id,
        transactionHash: hashA,
        toAddress: '0x5128123456789012345678901234567890ab652d',
        valueWei: '1000000000000000000',
        nonce: 3,
        blockNumber: '11425869',
      },
      treasury,
      runId: `run-${randomUUID()}`,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
      operationId: `op-${randomUUID()}`,
      actor: { type: 'cron', id: 'wallet-reconciler' },
    });
    expect(deduped.kind).toBe('deduped');
    expect(messages).toHaveLength(2);

    const stillOpen = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts
       WHERE alert_type = $1 AND entity_type = $2 AND state = 'open'`,
      [TREASURY_FINDING_ALERT_TYPE, TREASURY_FINDING_ENTITY_TYPE],
    );
    expect(stillOpen.rows[0]?.count).toBe('2');

    const byHash = await alerts.findOpenByEntity(
      TREASURY_FINDING_ENTITY_TYPE,
      hashA,
      TREASURY_FINDING_ALERT_TYPE,
    );
    expect(byHash).toBeDefined();
    expect(byHash?.pendingEmail).toBeUndefined();
    expect(byHash?.lastSentAt).toBeDefined();

    const auditCount = await handle.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events
       WHERE action = 'treasury.alert.email.sent'
         AND entity_id = $1`,
      [treasury.id],
    );
    expect(Number(auditCount.rows[0]?.count)).toBeGreaterThanOrEqual(2);
  });
});
