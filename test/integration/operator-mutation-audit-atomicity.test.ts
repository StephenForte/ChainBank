import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { acknowledgeAlert } from '../../src/app/alerts/acknowledge-alert.js';
import {
  TREASURY_FINDING_ALERT_TYPE,
  TREASURY_FINDING_ENTITY_TYPE,
} from '../../src/app/alerts/notify-treasury-finding.js';
import { mutateCredential } from '../../src/app/credentials/mutate-credential.js';
import { createOperatorMutationTransaction } from '../../src/infrastructure/db/operator-mutation-transaction.js';
import { alerts, apiCredentials, auditEvents } from '../../src/infrastructure/db/schema.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import {
  createIntegrationDatabase,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const NOW = new Date('2026-08-06T15:00:00.000Z');
const FINDING_HASH = `0x${'ab'.repeat(32)}`;

/**
 * Forces the next INSERT into audit_events to fail inside the same transaction
 * as the operator mutation, proving C21 rollback without changing repositories.
 */
async function installAuditFailureTrigger(handle: IntegrationDatabaseHandle): Promise<void> {
  await handle.pool.query(`
    CREATE OR REPLACE FUNCTION chainbank_test_fail_audit_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'chainbank_test_forced_audit_failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await handle.pool.query(`
    DROP TRIGGER IF EXISTS chainbank_test_fail_audit ON audit_events;
    CREATE TRIGGER chainbank_test_fail_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION chainbank_test_fail_audit_insert();
  `);
}

async function dropAuditFailureTrigger(handle: IntegrationDatabaseHandle): Promise<void> {
  await handle.pool.query(`DROP TRIGGER IF EXISTS chainbank_test_fail_audit ON audit_events;`);
  await handle.pool.query(`DROP FUNCTION IF EXISTS chainbank_test_fail_audit_insert();`);
}

describe.skipIf(!integrationEnabled)('operator mutation + audit atomicity (C21)', () => {
  let handle: IntegrationDatabaseHandle;
  let operatorCredentialId: string;
  let targetCredentialId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await dropAuditFailureTrigger(handle);
    await truncatePhase1Tables(handle.pool);
    // Shared truncate omits audit_events (append-only elsewhere); clear it here
    // so atomicity assertions are not poisoned by prior integration suites.
    await handle.pool.query('TRUNCATE TABLE audit_events RESTART IDENTITY CASCADE');
    await seedPhase1Fixtures(handle.db);

    const operator = generateApiToken();
    const [operatorRow] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: operator.tokenHash,
        tokenPrefix: operator.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (operatorRow === undefined) {
      throw new Error('Failed to seed operator credential');
    }
    operatorCredentialId = operatorRow.id;

    const target = generateApiToken();
    const [targetRow] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `target-${randomUUID()}`,
        role: 'project-service',
        tokenHash: target.tokenHash,
        tokenPrefix: target.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (targetRow === undefined) {
      throw new Error('Failed to seed target credential');
    }
    targetCredentialId = targetRow.id;
  });

  afterAll(async () => {
    await dropAuditFailureTrigger(handle);
    await handle.close();
  });

  async function seedOpenFindingAlert(): Promise<string> {
    const id = randomUUID();
    await handle.db.insert(alerts).values({
      id,
      alertType: TREASURY_FINDING_ALERT_TYPE,
      severity: 'critical',
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      entityId: FINDING_HASH,
      state: 'open',
      firstTriggeredAt: NOW,
      lastEvaluatedAt: NOW,
      lastSentAt: NOW,
      metadataJson: { transactionHash: FINDING_HASH, kind: 'unexplained_outgoing_transfer' },
    });
    return id;
  }

  it('rolls back acknowledgement when the audit insert fails, so a retry succeeds', async () => {
    const alertId = await seedOpenFindingAlert();
    await installAuditFailureTrigger(handle);

    const operatorMutations = createOperatorMutationTransaction(handle.db);
    await expect(
      acknowledgeAlert(
        { operatorMutations, clock: createFixedClock(NOW) },
        {
          role: 'operator',
          alertId,
          note: 'Confirmed operator hand-send.',
          operationId: 'req-audit-fail',
          actorId: operatorCredentialId,
          sourceIp: '127.0.0.1',
        },
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });

    const [row] = await handle.db.select().from(alerts).where(eq(alerts.id, alertId));
    expect(row?.state).toBe('open');
    expect(row?.acknowledgementNote).toBeNull();

    const auditRows = await handle.db.select().from(auditEvents);
    expect(auditRows).toHaveLength(0);

    await dropAuditFailureTrigger(handle);

    const acknowledged = await acknowledgeAlert(
      { operatorMutations, clock: createFixedClock(NOW) },
      {
        role: 'operator',
        alertId,
        note: 'Confirmed operator hand-send.',
        operationId: 'req-retry',
        actorId: operatorCredentialId,
        sourceIp: '127.0.0.1',
      },
    );
    expect(acknowledged.state).toBe('acknowledged');

    const [after] = await handle.db.select().from(alerts).where(eq(alerts.id, alertId));
    expect(after?.state).toBe('acknowledged');
  });

  it('on success writes exactly one acknowledgement audit row with stable action and metadata', async () => {
    const alertId = await seedOpenFindingAlert();
    const operatorMutations = createOperatorMutationTransaction(handle.db);

    await acknowledgeAlert(
      { operatorMutations, clock: createFixedClock(NOW) },
      {
        role: 'operator',
        alertId,
        note: 'Reviewed; benign treasury send.',
        operationId: 'req-success',
        actorId: operatorCredentialId,
        sourceIp: '10.0.0.2',
      },
    );

    const rows = await handle.db.select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'treasury.alert.acknowledged',
      entityType: 'alert',
      entityId: alertId,
      actorId: operatorCredentialId,
      requestId: 'req-success',
      sourceIp: '10.0.0.2',
    });
    expect(rows[0]?.metadata).toMatchObject({
      alertType: TREASURY_FINDING_ALERT_TYPE,
      entityType: TREASURY_FINDING_ENTITY_TYPE,
      findingEntityId: FINDING_HASH,
      note: 'Reviewed; benign treasury send.',
      previousState: 'open',
      nextState: 'acknowledged',
    });
  });

  it('rolls back credential revoke when the audit insert fails', async () => {
    await installAuditFailureTrigger(handle);
    const operatorMutations = createOperatorMutationTransaction(handle.db);

    await expect(
      mutateCredential(
        { operatorMutations, clock: createFixedClock(NOW) },
        {
          role: 'operator',
          credentialId: targetCredentialId,
          actorCredentialId: operatorCredentialId,
          action: 'revoke',
          operationId: 'req-cred-audit-fail',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });

    const [credential] = await handle.db
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.id, targetCredentialId));
    expect(credential?.enabled).toBe(true);
    expect(credential?.revokedAt).toBeNull();

    const auditRows = await handle.db.select().from(auditEvents);
    expect(auditRows).toHaveLength(0);
  });

  it('writes no audit entry when credential revoke mutation fails', async () => {
    // Force the mutation path to fail inside the transaction via a trigger on
    // api_credentials, after validation has already resolved the row.
    await handle.pool.query(`
      CREATE OR REPLACE FUNCTION chainbank_test_fail_credential_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'chainbank_test_forced_credential_failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await handle.pool.query(`
      DROP TRIGGER IF EXISTS chainbank_test_fail_credential ON api_credentials;
      CREATE TRIGGER chainbank_test_fail_credential
        BEFORE UPDATE ON api_credentials
        FOR EACH ROW EXECUTE FUNCTION chainbank_test_fail_credential_update();
    `);

    try {
      const operatorMutations = createOperatorMutationTransaction(handle.db);
      await expect(
        mutateCredential(
          { operatorMutations, clock: createFixedClock(NOW) },
          {
            role: 'operator',
            credentialId: targetCredentialId,
            actorCredentialId: operatorCredentialId,
            action: 'revoke',
            operationId: 'req-cred-mutation-fail',
            sourceIp: undefined,
          },
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });

      const auditRows = await handle.db.select().from(auditEvents);
      expect(auditRows).toHaveLength(0);

      const [credential] = await handle.db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.id, targetCredentialId));
      expect(credential?.enabled).toBe(true);
      expect(credential?.revokedAt).toBeNull();
    } finally {
      await handle.pool.query(`DROP TRIGGER IF EXISTS chainbank_test_fail_credential ON api_credentials;`);
      await handle.pool.query(`DROP FUNCTION IF EXISTS chainbank_test_fail_credential_update();`);
    }
  });

  it('on successful revoke writes exactly one credential.revoked audit row', async () => {
    const operatorMutations = createOperatorMutationTransaction(handle.db);

    await mutateCredential(
      { operatorMutations, clock: createFixedClock(NOW) },
      {
        role: 'operator',
        credentialId: targetCredentialId,
        actorCredentialId: operatorCredentialId,
        action: 'revoke',
        operationId: 'req-cred-success',
        sourceIp: '10.0.0.9',
      },
    );

    const rows = await handle.db.select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'credential.revoked',
      entityType: 'api_credential',
      entityId: targetCredentialId,
      actorId: operatorCredentialId,
      requestId: 'req-cred-success',
      sourceIp: '10.0.0.9',
    });
    expect(rows[0]?.metadata).toMatchObject({
      previous: { enabled: true, revokedAt: null },
      next: { enabled: false, revokedAt: NOW.toISOString() },
    });
  });
});
