import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureWalletFunded } from '../../src/app/funding/ensure-wallet-funded.js';
import type { BalanceReader, TreasurySigner } from '../../src/app/ports.js';
import { ChainBankError } from '../../src/domain/errors.js';
import { createFundingDispatchLock } from '../../src/infrastructure/db/funding-dispatch-lock.js';
import { createAlertRepository } from '../../src/infrastructure/db/repositories/alert-repository.js';
import { createAuditEventRepository } from '../../src/infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from '../../src/infrastructure/db/repositories/balance-observation-repository.js';
import { createCredentialScopeRepository } from '../../src/infrastructure/db/repositories/credential-scope-repository.js';
import { createFundingOperationRepository } from '../../src/infrastructure/db/repositories/funding-operation-repository.js';
import { createFundingTransactionRepository } from '../../src/infrastructure/db/repositories/funding-transaction-repository.js';
import { createManagedWalletRepository } from '../../src/infrastructure/db/repositories/managed-wallet-repository.js';
import { createTreasuryRepository } from '../../src/infrastructure/db/repositories/treasury-repository.js';
import {
  apiCredentials,
  fundingOperations,
  fundingPolicies,
  fundingTransactions,
} from '../../src/infrastructure/db/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { generateApiToken } from '../../src/shared/api-token.js';
import { createFixedClock } from '../support/clock.js';
import {
  createControllableSigner,
  createDeferred,
  createFakeReceiptTracker,
} from '../support/funding-fakes.js';
import {
  createIntegrationDatabase,
  listGrantedAdvisoryLockPids,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';
import { integrationEnabled } from '../support/integration-setup.js';

const ONE_ETH = 10n ** 18n;
const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';

describe.skipIf(!integrationEnabled)('Funding crash recovery (integration)', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let credentialId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase({ poolMax: 12 });
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    await handle.db.insert(fundingPolicies).values({
      managedWalletId: seed.managedWalletId,
      minimumBalanceWei: ONE_ETH.toString(),
      targetBalanceWei: (2n * ONE_ETH).toString(),
      maximumTopUpWei: (5n * ONE_ETH).toString(),
      version: 1,
    });

    const generated = generateApiToken();
    const [credential] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `operator-${randomUUID()}`,
        role: 'operator',
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
      })
      .returning({ id: apiCredentials.id });
    if (credential === undefined) {
      throw new Error('failed to seed operator credential');
    }
    credentialId = credential.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function createBalanceReader(): BalanceReader {
    return {
      readBalance(address) {
        const normalized = address.toLowerCase();
        const balanceWei = normalized === TREASURY_ADDRESS.toLowerCase() ? 20n * ONE_ETH : ONE_ETH / 10n;
        return Promise.resolve({
          kind: 'observed',
          balanceWei,
          blockNumber: 42n,
          observedAt: new Date('2026-07-29T12:00:00.000Z'),
        });
      },
      verifyChainId() {
        return Promise.resolve({ matches: true, observedChainId: 11_155_111 });
      },
    };
  }

  function buildEnsureDeps(signer: TreasurySigner) {
    const clock = createFixedClock();
    return {
      managedWallets: createManagedWalletRepository(handle.db),
      treasuries: createTreasuryRepository(handle.db),
      balanceObservations: createBalanceObservationRepository(handle.db),
      balanceReader: createBalanceReader(),
      credentialScopes: createCredentialScopeRepository(handle.db),
      auditEvents: createAuditEventRepository(handle.db),
      alerts: createAlertRepository(handle.db),
      emailSender: undefined,
      operations: createFundingOperationRepository(handle.db),
      transactions: createFundingTransactionRepository(handle.db),
      lock: createFundingDispatchLock(handle.db),
      receiptTracker: createFakeReceiptTracker({
        kind: 'confirmed',
        confirmedAt: new Date('2026-07-29T12:00:01.000Z'),
      }),
      signer,
      clock,
      idGenerator: { next: () => randomUUID() },
      logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
      isFundingEnabled: true,
      isFundingKillSwitchActive: false,
      confirmations: 1,
      confirmationTimeoutMs: 5_000,
      operatorRecipients: ['operator@example.com'],
      dashboardBaseUrl: 'http://localhost:3000',
      environment: 'test',
    };
  }

  it('terminating the advisory-lock backend releases the lock without deadlocking a follow-up', async () => {
    const sendHold = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const signer = createControllableSigner({
      onSend: async () => {
        firstEntered.resolve();
        await sendHold.promise;
      },
      getNonce: () => signer.sendCalls,
    });

    const deps = buildEnsureDeps(signer);
    const crashedKey = 'crash-abort-key';
    const crashedPromise = ensureWalletFunded(deps, {
      walletId: seed.managedWalletId,
      idempotencyKey: crashedKey,
      role: 'operator',
      credentialId,
      correlationId: 'corr-crash-abort',
      sourceIp: undefined,
    });

    await firstEntered.promise;

    const lockHolders = await listGrantedAdvisoryLockPids(handle.pool);
    expect(lockHolders.length).toBeGreaterThanOrEqual(1);

    for (const pid of lockHolders) {
      const terminated = await handle.pool.query<{ pg_terminate_backend: boolean }>(
        'SELECT pg_terminate_backend($1) AS pg_terminate_backend',
        [pid],
      );
      expect(terminated.rows[0]?.pg_terminate_backend).toBe(true);
    }

    // Lock must be gone so a subsequent dispatcher is not stuck on pg_advisory_xact_lock.
    await expect
      .poll(async () => listGrantedAdvisoryLockPids(handle.pool), { interval: 10, timeout: 5_000 })
      .toEqual([]);

    // Unblock the crashed worker so it observes the dead connection and settles.
    sendHold.resolve();
    await expect(crashedPromise).rejects.toBeTruthy();

    // TX.10: broadcast intent is committed outside the lock txn before send, so
    // terminating the lock-holder cannot erase the gate.
    // - funding_operations row for the crashed key remains (pre-lock commit).
    // - A durable in-flight funding_transactions row wedges the wallet.
    // - Same idempotency key replays without a second send.
    // - A different key is refused with PENDING_FUNDING_EXISTS (fail closed).
    const ops = await handle.db.select().from(fundingOperations);
    const crashedOps = ops.filter((op) => op.idempotencyKey === `${seed.managedWalletId}:${crashedKey}`);
    expect(crashedOps).toHaveLength(1);

    const txs = await handle.db.select().from(fundingTransactions);
    expect(txs).toHaveLength(1);
    expect(['submission_unknown', 'submitted']).toContain(txs[0]?.status);
    expect(txs[0]?.nonce).toBeTypeOf('number');

    const replaySigner = createControllableSigner({});
    const replayDeps = buildEnsureDeps(replaySigner);
    const replay = await ensureWalletFunded(replayDeps, {
      walletId: seed.managedWalletId,
      idempotencyKey: crashedKey,
      role: 'operator',
      credentialId,
      correlationId: 'corr-crash-replay',
      sourceIp: undefined,
    });
    // Same-key replay maps the durable in-flight intent to `pending` (not
    // `funded` — nothing confirmed — and not `no-op`, which requires no tx row).
    expect(replay.status).toBe('pending');
    expect(replaySigner.sendCalls).toBe(0);

    const recoverySigner = createControllableSigner({});
    const recoveryDeps = buildEnsureDeps(recoverySigner);
    await expect(
      ensureWalletFunded(recoveryDeps, {
        walletId: seed.managedWalletId,
        idempotencyKey: 'crash-recovery-new-key',
        role: 'operator',
        credentialId,
        correlationId: 'corr-crash-recovery',
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'PENDING_FUNDING_EXISTS' });
    expect(recoverySigner.sendCalls).toBe(0);
  });

  it('ambiguous mid-lock send failure records submission_unknown and wedges the wallet', async () => {
    // Simulates a worker that may have broadcast before the error returned.
    // C4: submission_unknown is non-terminal and gates further funding.
    const signer = createControllableSigner({
      sendError: () =>
        new ChainBankError('RPC_UNAVAILABLE', 'transport failed after possible broadcast', {
          publicMessage: 'The transfer could not be submitted.',
        }),
      getNonce: () => 0,
    });

    const deps = buildEnsureDeps(signer);
    await expect(
      ensureWalletFunded(deps, {
        walletId: seed.managedWalletId,
        idempotencyKey: 'ambiguous-send',
        role: 'operator',
        credentialId,
        correlationId: 'corr-ambiguous',
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });

    const rows = await handle.db.select().from(fundingTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('submission_unknown');
    expect(rows[0]?.managedWalletId).toBe(seed.managedWalletId);

    const followUpSigner = createControllableSigner({});
    const followUpDeps = buildEnsureDeps(followUpSigner);
    await expect(
      ensureWalletFunded(followUpDeps, {
        walletId: seed.managedWalletId,
        idempotencyKey: 'after-ambiguous',
        role: 'operator',
        credentialId,
        correlationId: 'corr-after-ambiguous',
        sourceIp: undefined,
      }),
    ).rejects.toMatchObject({ code: 'PENDING_FUNDING_EXISTS' });
    expect(followUpSigner.sendCalls).toBe(0);

    // Actual behavior: wallet remains wedged behind the pending-tx gate until
    // Phase 4 reconciliation resolves the submission_unknown row.
  });
});
