import { describe, expect, it, vi } from 'vitest';
import { TREASURY_RESERVE_ALERT_TYPE } from '../../../../src/app/alerts/notify-treasury-reserve-alert.js';
import { ensureWalletFunded } from '../../../../src/app/funding/ensure-wallet-funded.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  CredentialScope,
  CredentialScopeRepository,
  EmailMessage,
  EmailSender,
  ManagedWallet,
  ManagedWalletRepository,
  StoredOpenAlert,
  Treasury,
  TreasuryRepository,
} from '../../../../src/app/ports.js';
import { ChainBankError } from '../../../../src/domain/errors.js';
import type { Role } from '../../../../src/domain/auth/roles.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';
import {
  createFakeReceiptTracker,
  createFakeSigner,
  createInMemoryFundingStores,
} from '../../../support/funding-fakes.js';

const ONE_ETH = 10n ** 18n;
const WALLET_ID = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENV_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REGISTERED_ADDRESS = '0x2222222222222222222222222222222222222222';
const ARBITRARY_ADDRESS = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef';

const now = new Date('2026-07-29T12:00:00.000Z');

function buildWallet(overrides: Partial<ManagedWallet> = {}): ManagedWallet {
  return {
    id: WALLET_ID,
    project: { id: PROJECT_ID, slug: 'fortel2', name: 'ForteL2', enabled: true },
    environment: {
      id: ENV_ID,
      projectId: PROJECT_ID,
      slug: 'dev',
      name: 'Development',
      enabled: true,
    },
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    role: 'signer',
    address: REGISTERED_ADDRESS.toLowerCase(),
    addressDisplay: REGISTERED_ADDRESS,
    enabled: true,
    criticalAtStartup: false,
    reconciliationEnabled: false,
    policy: {
      id: 'policy-1',
      managedWalletId: WALLET_ID,
      minimumBalanceWei: ONE_ETH,
      targetBalanceWei: 2n * ONE_ETH,
      maximumTopUpWei: 5n * ONE_ETH,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildTreasury(): Treasury {
  return {
    id: 'treasury-1',
    chain: {
      id: 'chain-1',
      slug: 'sepolia',
      chainId: 11_155_111,
      displayName: 'Sepolia',
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://sepolia.etherscan.io',
    },
    address: '0x1111111111111111111111111111111111111111',
    addressDisplay: '0x1111111111111111111111111111111111111111',
    // Compliant ladder: reserve < critical (D3 / assertValidTreasuryThresholds).
    thresholds: {
      warningBalanceWei: (ONE_ETH * 75n) / 100n,
      criticalBalanceWei: (ONE_ETH * 3n) / 10n,
      recoveryBalanceWei: (ONE_ETH * 15n) / 10n,
      minimumReserveWei: ONE_ETH / 10n,
    },
    status: 'healthy',
    lastObservedBalanceWei: 20n * ONE_ETH,
    lastObservedAt: now,
    lastCheckedAt: now,
    lastCheckErrorCode: undefined,
    enabled: true,
  };
}

function createFakeAlerts(): AlertRepository & { readonly rows: Map<string, StoredOpenAlert> } {
  const rows = new Map<string, StoredOpenAlert>();
  let seq = 0;
  return {
    rows,
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
      rows.set(input.id, {
        ...existing,
        lastEvaluatedAt: input.lastEvaluatedAt,
        metadata: input.metadata === undefined ? existing.metadata : { ...existing.metadata, ...input.metadata },
      });
      return Promise.resolve();
    },
  };
}

function createSender(behavior: 'sent' | 'fail' = 'sent'): {
  readonly sender: EmailSender;
  readonly messages: EmailMessage[];
} {
  const messages: EmailMessage[] = [];
  return {
    messages,
    sender: {
      send(message) {
        messages.push(message);
        if (behavior === 'fail') {
          return Promise.resolve({
            kind: 'failed' as const,
            errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' as const,
            reason: 'simulated outage',
          });
        }
        return Promise.resolve({ kind: 'sent' as const, providerMessageId: `msg-${String(messages.length)}` });
      },
    },
  };
}

function createBalanceReader(balances: Readonly<Record<string, bigint>>): BalanceReader & {
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    readBalance(address) {
      reads.push(address.toLowerCase());
      const balanceWei = balances[address.toLowerCase()];
      if (balanceWei === undefined) {
        return Promise.resolve({
          kind: 'unavailable',
          errorCode: 'RPC_UNAVAILABLE',
          reason: 'missing fixture balance',
          observedAt: now,
        });
      }
      return Promise.resolve({
        kind: 'observed',
        balanceWei,
        blockNumber: 1n,
        observedAt: now,
      });
    },
    verifyChainId() {
      return Promise.resolve({ matches: true, observedChainId: 11_155_111 });
    },
  };
}

function createScopeRepo(scopes: readonly CredentialScope[]): CredentialScopeRepository {
  return {
    listByCredentialId: vi.fn(() => Promise.resolve(scopes)),
    insert: vi.fn(),
  };
}

function buildDeps(options?: {
  readonly role?: Role;
  readonly scopes?: readonly CredentialScope[];
  readonly wallet?: ManagedWallet | undefined;
  readonly walletBalanceWei?: bigint;
  readonly treasuryBalanceWei?: bigint;
  readonly isFundingEnabled?: boolean;
  readonly isFundingKillSwitchActive?: boolean;
  readonly signer?: ReturnType<typeof createFakeSigner>;
  readonly receiptOutcome?: 'confirmed' | 'pending';
  readonly estimatedCostWei?: bigint;
  readonly emailBehavior?: 'sent' | 'fail';
}) {
  const wallet = options && 'wallet' in options ? options.wallet : buildWallet();
  const treasury = buildTreasury();
  const stores = createInMemoryFundingStores();
  const alerts = createFakeAlerts();
  const { sender, messages } = createSender(options?.emailBehavior ?? 'sent');
  const signer =
    options?.signer ??
    createFakeSigner({
      ...(options?.estimatedCostWei === undefined ? {} : { estimatedCostWei: options.estimatedCostWei }),
      send: (input) => {
        // Destination must be the registered allowlisted address only.
        expect(input.to.toLowerCase()).toBe(REGISTERED_ADDRESS.toLowerCase());
        expect(input.to.toLowerCase()).not.toBe(ARBITRARY_ADDRESS.toLowerCase());
        return Promise.resolve({ transactionHash: `0x${'ab'.repeat(32)}` });
      },
    });
  const balanceReader = createBalanceReader({
    [REGISTERED_ADDRESS.toLowerCase()]: options?.walletBalanceWei ?? ONE_ETH / 10n,
    [treasury.address.toLowerCase()]: options?.treasuryBalanceWei ?? 20n * ONE_ETH,
  });
  const auditEvents: AuditEventRepository = {
    record: vi.fn(() => Promise.resolve()),
  };
  const balanceObservations: BalanceObservationRepository = {
    record: vi.fn(() => Promise.resolve()),
    findLatest: vi.fn(),
  };
  const managedWallets: ManagedWalletRepository = {
    findById: vi.fn(() => Promise.resolve(wallet)),
    insert: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
  };
  const treasuries: TreasuryRepository = {
    listEnabled: vi.fn(() => Promise.resolve([treasury])),
    findById: vi.fn(),
    upsert: vi.fn(),
    recordCheckSuccess: vi.fn(),
    recordCheckFailure: vi.fn(),
  };

  let n = 0;
  const clock = createFixedClock(now);
  const dependencies = {
    managedWallets,
    treasuries,
    balanceObservations,
    balanceReader,
    credentialScopes: createScopeRepo(options?.scopes ?? []),
    auditEvents,
    alerts,
    emailSender: sender,
    operations: stores.operations,
    transactions: stores.transactions,
    lock: stores.lock,
    receiptTracker: createFakeReceiptTracker(
      options?.receiptOutcome === 'pending' ? { kind: 'pending' } : { kind: 'confirmed', confirmedAt: now },
    ),
    signer,
    clock,
    idGenerator: { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    logger: createLogger({ level: 'silent', serviceRole: 'web', environment: 'test' }),
    isFundingEnabled: options?.isFundingEnabled ?? true,
    isFundingKillSwitchActive: options?.isFundingKillSwitchActive ?? false,
    confirmations: 1,
    confirmationTimeoutMs: 1_000,
    operatorRecipients: ['operator@example.com'] as const,
    dashboardBaseUrl: 'http://localhost:3000',
    environment: 'test',
  };

  return {
    dependencies,
    signer,
    stores,
    alerts,
    messages,
    auditEvents,
    balanceObservations,
    balanceReader,
    managedWallets,
    input: {
      walletId: WALLET_ID,
      idempotencyKey: 'idem-1',
      role: options?.role ?? 'operator',
      credentialId: CREDENTIAL_ID,
      correlationId: 'corr-1',
      sourceIp: '127.0.0.1',
    },
  };
}

describe('ensureWalletFunded', () => {
  it('returns funded after a fresh balance read and confirmed transfer', async () => {
    const { dependencies, input, balanceReader, balanceObservations, auditEvents, signer } = buildDeps({});
    const result = await ensureWalletFunded(dependencies, input);

    expect(result.status).toBe('funded');
    // deficit to target: 2 ETH - 0.1 ETH = 1.9 ETH
    expect(result.transferredWei).toBe(2n * ONE_ETH - ONE_ETH / 10n);
    expect(result.balanceBeforeWei).toBe(ONE_ETH / 10n);
    expect(result.transactionHash).toMatch(/^0x/);
    expect(balanceReader.reads.length).toBeGreaterThanOrEqual(2);
    expect(balanceObservations.record).toHaveBeenCalledTimes(2);
    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.ensure_funded', actorId: CREDENTIAL_ID }),
    );
    expect(signer.sendCalls).toBe(1);
  });

  it('returns no-op when the fresh wallet balance is already at minimum', async () => {
    const { dependencies, input, signer } = buildDeps({ walletBalanceWei: ONE_ETH });
    const result = await ensureWalletFunded(dependencies, input);
    expect(result.status).toBe('no-op');
    expect(result.transferredWei).toBeUndefined();
    expect(signer.sendCalls).toBe(0);
  });

  it('returns pending when confirmation times out', async () => {
    const { dependencies, input } = buildDeps({ receiptOutcome: 'pending' });
    const result = await ensureWalletFunded(dependencies, input);
    expect(result.status).toBe('pending');
    expect(result.transactionHash).toBeDefined();
  });

  it('returns blocked with FUNDING_BLOCKED_RESERVE when reserve would be breached', async () => {
    // Low treasury balance (not a raised reserve) — spendable is zero after reserve + gas.
    const { dependencies, input, signer, alerts, messages } = buildDeps({
      treasuryBalanceWei: ONE_ETH / 10n,
      estimatedCostWei: ONE_ETH / 100n,
    });
    const result = await ensureWalletFunded(dependencies, input);
    expect(result.status).toBe('blocked');
    expect(result.reasonCode).toBe('FUNDING_BLOCKED_RESERVE');
    expect(signer.sendCalls).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toMatch(/RESERVE/);
    expect([...alerts.rows.values()][0]?.alertType).toBe(TREASURY_RESERVE_ALERT_TYPE);
  });

  it('keeps FUNDING_BLOCKED_RESERVE when reserve-alert email send fails', async () => {
    const { dependencies, input, messages, alerts } = buildDeps({
      treasuryBalanceWei: ONE_ETH / 10n,
      estimatedCostWei: ONE_ETH / 100n,
      emailBehavior: 'fail',
    });
    const result = await ensureWalletFunded(dependencies, input);
    expect(result.status).toBe('blocked');
    expect(result.reasonCode).toBe('FUNDING_BLOCKED_RESERVE');
    expect(messages).toHaveLength(1);
    const open = [...alerts.rows.values()][0];
    expect(open?.pendingEmail).toBe('critical');
    expect(open?.lastSentAt).toBeUndefined();
  });

  it('refuses FUNDING_ENABLED=false without calling the signer', async () => {
    const { dependencies, input, signer, auditEvents } = buildDeps({ isFundingEnabled: false });
    await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
      code: 'FUNDING_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
    expect(auditEvents.record).toHaveBeenCalled();
  });

  it('refuses when the kill switch is active without calling the signer', async () => {
    const { dependencies, input, signer } = buildDeps({ isFundingKillSwitchActive: true });
    await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
      code: 'FUNDING_DISABLED',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('maps PENDING_FUNDING_EXISTS to a conflict error', async () => {
    const { dependencies, input, signer } = buildDeps({});
    // Seed an in-flight transfer for the same wallet.
    await dependencies.operations.insertPending({
      id: 'prior-op',
      operationType: 'ensure_funded',
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      idempotencyKey: undefined,
      requestedBy: 'other',
      startedAt: now,
    });
    await dependencies.transactions.insertCreated({
      id: 'prior-tx',
      operationId: 'prior-op',
      treasuryId: 'treasury-1',
      managedWalletId: WALLET_ID,
      amountWei: ONE_ETH,
      createdAt: now,
    });
    await dependencies.transactions.markSubmitted('prior-tx', {
      transactionHash: `0x${'cd'.repeat(32)}`,
      nonce: 1,
      submittedAt: now,
    });

    await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
      code: 'PENDING_FUNDING_EXISTS',
    });
    expect(signer.sendCalls).toBe(0);
  });

  describe('authorization matrix', () => {
    it('allows operator', async () => {
      const { dependencies, input } = buildDeps({ role: 'operator' });
      await expect(ensureWalletFunded(dependencies, input)).resolves.toMatchObject({
        status: 'funded',
      });
    });

    it('allows project-service when scoped to the wallet environment', async () => {
      const { dependencies, input } = buildDeps({
        role: 'project-service',
        scopes: [
          {
            id: '1',
            credentialId: CREDENTIAL_ID,
            projectId: PROJECT_ID,
            environmentId: ENV_ID,
            createdAt: now,
          },
        ],
      });
      await expect(ensureWalletFunded(dependencies, input)).resolves.toMatchObject({
        status: 'funded',
      });
    });

    it('denies project-service when out of scope', async () => {
      const { dependencies, input, signer } = buildDeps({
        role: 'project-service',
        scopes: [
          {
            id: '1',
            credentialId: CREDENTIAL_ID,
            projectId: OTHER_PROJECT,
            environmentId: undefined,
            createdAt: now,
          },
        ],
      });
      await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
        code: 'SCOPE_DENIED',
      });
      expect(signer.sendCalls).toBe(0);
    });

    it('denies read-only', async () => {
      const { dependencies, input, signer } = buildDeps({ role: 'read-only' });
      await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
        code: 'INSUFFICIENT_ROLE',
      });
      expect(signer.sendCalls).toBe(0);
    });

    it('denies cron roles', async () => {
      for (const role of ['cron-treasury-monitor', 'cron-reconciler'] as const) {
        const { dependencies, input, signer } = buildDeps({ role });
        await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
          code: 'INSUFFICIENT_ROLE',
        });
        expect(signer.sendCalls).toBe(0);
      }
    });
  });

  it('never lets an arbitrary caller address reach the signer', async () => {
    // The service input and dispatch input have no address field. Even if a
    // caller somehow tried to influence destination, only the DB row is used.
    const { dependencies, input, signer, managedWallets } = buildDeps({});
    const result = await ensureWalletFunded(dependencies, {
      ...input,
      // @ts-expect-error intentional: prove unknown address fields are ignored
      address: ARBITRARY_ADDRESS,
      to: ARBITRARY_ADDRESS,
    });
    expect(result.status).toBe('funded');
    expect(managedWallets.findById).toHaveBeenCalledWith(WALLET_ID);
    expect(signer.sendCalls).toBe(1);
  });

  it('refuses to sign when the signing key is not the configured treasury account', async () => {
    // The treasury row's address and the signing key are independent config.
    // If they diverge, the reserve floor guards an account that is not spending.
    const signer = createFakeSigner({ address: '0x9999999999999999999999999999999999999999' });
    const { dependencies, input } = buildDeps({ signer });

    await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    expect(signer.sendCalls).toBe(0);
  });

  it('does not leak the signer address in the mismatch error', async () => {
    const signerAddress = '0x9999999999999999999999999999999999999999';
    const signer = createFakeSigner({ address: signerAddress });
    const { dependencies, input } = buildDeps({ signer });

    const error = await ensureWalletFunded(dependencies, input).catch((caught: unknown) => caught);
    expect(JSON.stringify(error)).not.toContain(signerAddress);
  });

  it('scopes the idempotency key to the wallet so a reused key cannot replay another wallet', async () => {
    const { dependencies, input, stores } = buildDeps({});
    await ensureWalletFunded(dependencies, input);

    const operations = [...stores.opsById.values()];
    expect(operations).toHaveLength(1);
    // Namespacing is what stops the same key against a different wallet from
    // returning this wallet's transfer as though the other one was funded.
    expect(operations[0]?.idempotencyKey).toBe(`${WALLET_ID}:${input.idempotencyKey}`);
    expect(operations[0]?.idempotencyKey).not.toBe(input.idempotencyKey);
  });

  it('returns WALLET_NOT_FOUND when the id is unknown', async () => {
    const { dependencies, input } = buildDeps({ wallet: undefined });
    await expect(ensureWalletFunded(dependencies, input)).rejects.toBeInstanceOf(ChainBankError);
    await expect(ensureWalletFunded(dependencies, input)).rejects.toMatchObject({
      code: 'WALLET_NOT_FOUND',
    });
  });
});
