import { describe, expect, it, vi } from 'vitest';
import type { AuditEventRepository, Treasury, TreasuryRepository } from '../../../../src/app/ports.js';
import { setTreasuryEnabled } from '../../../../src/app/treasury/set-treasury-enabled.js';
import { ROLES, type Role } from '../../../../src/domain/auth/roles.js';
import { ChainBankError } from '../../../../src/domain/errors.js';

const now = new Date('2026-08-01T12:00:00.000Z');

const treasury: Treasury = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
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
  thresholds: {
    warningBalanceWei: 750_000_000_000_000_000n,
    criticalBalanceWei: 300_000_000_000_000_000n,
    recoveryBalanceWei: 1_500_000_000_000_000_000n,
    minimumReserveWei: 100_000_000_000_000_000n,
  },
  status: 'healthy',
  lastObservedBalanceWei: undefined,
  lastObservedAt: undefined,
  lastCheckedAt: undefined,
  lastCheckErrorCode: undefined,
  enabled: true,
};

function buildRepository(overrides: Partial<TreasuryRepository> = {}): TreasuryRepository {
  return {
    upsert: vi.fn(),
    findById: vi.fn(() => Promise.resolve(treasury)),
    listEnabled: vi.fn(),
    setEnabled: vi.fn((_id: string, enabled: boolean) =>
      Promise.resolve({ ...treasury, enabled, lastCheckedAt: now }),
    ),
    recordCheckSuccess: vi.fn(),
    recordCheckFailure: vi.fn(),
    ...overrides,
  };
}

function buildAuditEvents(): AuditEventRepository {
  return { record: vi.fn(() => Promise.resolve(undefined)) };
}

describe('setTreasuryEnabled authorization', () => {
  const deniedRoles: readonly Role[] = ROLES.filter((role): role is Role => role !== 'operator');

  it.each(deniedRoles.map((role) => [role] as const))(
    'denies %s from enabling or disabling a treasury',
    async (role) => {
      await expect(
        setTreasuryEnabled(
          { treasuries: buildRepository(), auditEvents: buildAuditEvents() },
          {
            role,
            treasuryId: treasury.id,
            enabled: false,
            operationId: 'req-1',
            actorId: 'cred-1',
            sourceIp: '127.0.0.1',
          },
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    },
  );

  it('allows operator to disable a treasury', async () => {
    const treasuries = buildRepository();
    const auditEvents = buildAuditEvents();

    const updated = await setTreasuryEnabled(
      { treasuries, auditEvents },
      {
        role: 'operator',
        treasuryId: treasury.id,
        enabled: false,
        operationId: 'req-1',
        actorId: 'cred-1',
        sourceIp: '127.0.0.1',
      },
    );

    expect(updated.enabled).toBe(false);
    expect(treasuries.setEnabled).toHaveBeenCalledWith(treasury.id, false);
  });

  it('allows operator to re-enable a treasury', async () => {
    const disabled = { ...treasury, enabled: false };
    const treasuries = buildRepository({
      findById: vi.fn(() => Promise.resolve(disabled)),
      setEnabled: vi.fn((_id: string, enabled: boolean) =>
        Promise.resolve({ ...disabled, enabled }),
      ),
    });
    const auditEvents = buildAuditEvents();

    const updated = await setTreasuryEnabled(
      { treasuries, auditEvents },
      {
        role: 'operator',
        treasuryId: treasury.id,
        enabled: true,
        operationId: 'req-2',
        actorId: 'cred-1',
        sourceIp: undefined,
      },
    );

    expect(updated.enabled).toBe(true);
    expect(treasuries.setEnabled).toHaveBeenCalledWith(treasury.id, true);
  });
});

describe('setTreasuryEnabled audit and errors', () => {
  it('writes treasury.disabled with previous and next enabled state', async () => {
    const treasuries = buildRepository();
    const auditEvents = buildAuditEvents();

    await setTreasuryEnabled(
      { treasuries, auditEvents },
      {
        role: 'operator',
        treasuryId: treasury.id,
        enabled: false,
        operationId: 'req-audit',
        actorId: 'cred-operator',
        sourceIp: '203.0.113.10',
      },
    );

    expect(auditEvents.record).toHaveBeenCalledWith({
      actorType: 'api_credential',
      actorId: 'cred-operator',
      action: 'treasury.disabled',
      entityType: 'treasury',
      entityId: treasury.id,
      requestId: 'req-audit',
      sourceIp: '203.0.113.10',
      metadata: {
        address: treasury.address,
        chainId: treasury.chain.chainId,
        previous: { enabled: true },
        next: { enabled: false },
      },
    });
  });

  it('writes treasury.enabled when re-enabling', async () => {
    const disabled = { ...treasury, enabled: false };
    const treasuries = buildRepository({
      findById: vi.fn(() => Promise.resolve(disabled)),
      setEnabled: vi.fn(() => Promise.resolve({ ...disabled, enabled: true })),
    });
    const auditEvents = buildAuditEvents();

    await setTreasuryEnabled(
      { treasuries, auditEvents },
      {
        role: 'operator',
        treasuryId: treasury.id,
        enabled: true,
        operationId: 'req-enable',
        actorId: 'cred-operator',
        sourceIp: undefined,
      },
    );

    expect(auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'treasury.enabled',
        metadata: expect.objectContaining({
          previous: { enabled: false },
          next: { enabled: true },
        }),
      }),
    );
  });

  it('returns TREASURY_NOT_FOUND for an unknown id without mutating', async () => {
    const treasuries = buildRepository({
      findById: vi.fn(() => Promise.resolve(undefined)),
    });
    const auditEvents = buildAuditEvents();

    await expect(
      setTreasuryEnabled(
        { treasuries, auditEvents },
        {
          role: 'operator',
          treasuryId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          enabled: false,
          operationId: 'req-missing',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'TREASURY_NOT_FOUND' });

    expect(treasuries.setEnabled).not.toHaveBeenCalled();
    expect(auditEvents.record).not.toHaveBeenCalled();
  });

  it('allows disabling the only enabled treasury for a chain', async () => {
    // Per-treasury enable flag (AGENTS.md §18). Downstream funding fails closed
    // with TREASURY_NOT_FOUND; the use case must not invent a "last treasury"
    // guard that blocks the rotation path.
    const treasuries = buildRepository();
    const auditEvents = buildAuditEvents();

    await expect(
      setTreasuryEnabled(
        { treasuries, auditEvents },
        {
          role: 'operator',
          treasuryId: treasury.id,
          enabled: false,
          operationId: 'req-last',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).resolves.toMatchObject({ enabled: false });

    expect(treasuries.setEnabled).toHaveBeenCalledWith(treasury.id, false);
  });

  it('throws ChainBankError rather than a generic Error on unknown id', async () => {
    const treasuries = buildRepository({
      findById: vi.fn(() => Promise.resolve(undefined)),
    });

    await expect(
      setTreasuryEnabled(
        { treasuries, auditEvents: buildAuditEvents() },
        {
          role: 'operator',
          treasuryId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          enabled: false,
          operationId: 'req-1',
          actorId: 'cred-1',
          sourceIp: undefined,
        },
      ),
    ).rejects.toBeInstanceOf(ChainBankError);
  });
});
