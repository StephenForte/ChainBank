import { describe, expect, it, vi } from 'vitest';
import { checkTreasuryBalance } from '../../../src/app/treasury/check-treasury-balance.js';
import type {
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  Treasury,
  TreasuryRepository,
} from '../../../src/app/ports.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { parseEtherToWei } from '../../../src/domain/wei.js';
import { createInlineOperatorMutations } from '../../support/operator-mutations.js';

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
    criticalBalanceWei: parseEtherToWei('0.25', 'c'),
    warningBalanceWei: parseEtherToWei('1', 'w'),
    recoveryBalanceWei: parseEtherToWei('2', 'r'),
    minimumReserveWei: parseEtherToWei('0.1', 'm'),
  },
  status: 'unknown',
  lastObservedBalanceWei: undefined,
  lastObservedAt: undefined,
  lastCheckedAt: undefined,
  lastCheckErrorCode: undefined,
  lastOutgoingScanBlock: undefined,
  lastOutgoingScanAt: undefined,
  lastOutgoingScanNonce: undefined,
  enabled: true,
};

function deps(overrides: { reading?: Awaited<ReturnType<BalanceReader['readBalance']>> }): {
  treasuries: TreasuryRepository;
  balanceObservations: BalanceObservationRepository;
  balanceReader: BalanceReader;
  auditEvents: AuditEventRepository;
  operatorMutations: ReturnType<typeof createInlineOperatorMutations>;
} {
  const observedAt = new Date('2026-07-26T12:00:00.000Z');
  const reading =
    overrides.reading ??
    ({
      kind: 'observed',
      balanceWei: parseEtherToWei('3', 'b'),
      blockNumber: 12_345_678n,
      observedAt,
    } as const);

  const treasuries: TreasuryRepository = {
    upsert: vi.fn(),
    findById: vi.fn(() => Promise.resolve(treasury)),
    listEnabled: vi.fn(() => Promise.resolve([treasury])),
    setEnabled: vi.fn(),
    recordCheckSuccess: vi.fn(() =>
      Promise.resolve({
        ...treasury,
        status: 'healthy' as const,
        lastObservedBalanceWei: reading.kind === 'observed' ? reading.balanceWei : undefined,
      }),
    ),
    recordCheckFailure: vi.fn(() =>
      Promise.resolve({ ...treasury, status: 'unknown' as const, lastCheckErrorCode: 'RPC_UNAVAILABLE' }),
    ),
    recordOutgoingScanComplete: vi.fn(),
  };
  const balanceObservations: BalanceObservationRepository = {
    record: vi.fn(() => Promise.resolve(undefined)),
    findLatest: vi.fn(() => Promise.resolve(undefined)),
  };
  const auditEvents: AuditEventRepository = {
    record: vi.fn(() => Promise.resolve(undefined)),
  };
  return {
    treasuries,
    balanceObservations,
    balanceReader: {
      readBalance: vi.fn(() => Promise.resolve(reading)),
      verifyChainId: vi.fn(() => Promise.resolve({ matches: true, observedChainId: 11155111 })),
    },
    auditEvents,
    operatorMutations: createInlineOperatorMutations({
      treasuries,
      balanceObservations,
      auditEvents,
    }),
  };
}

describe('checkTreasuryBalance', () => {
  it('records an observation and success when the RPC returns a balance', async () => {
    const dependencies = deps({});
    const result = await checkTreasuryBalance(dependencies, {
      treasuryId: treasury.id,
      role: 'operator',
      operationId: 'op-1',
      actor: { type: 'api_credential', id: 'cred-1' },
    });

    expect(result.reading.kind).toBe('observed');
    expect(dependencies.balanceObservations.record).toHaveBeenCalledOnce();
    expect(dependencies.treasuries.recordCheckSuccess).toHaveBeenCalledOnce();
    expect(dependencies.treasuries.recordCheckFailure).not.toHaveBeenCalled();
  });

  it('marks status unknown on RPC failure without inventing a zero balance', async () => {
    const dependencies = deps({
      reading: {
        kind: 'unavailable',
        errorCode: 'RPC_UNAVAILABLE',
        reason: 'timeout',
        observedAt: new Date('2026-07-26T12:00:00.000Z'),
      },
    });

    const result = await checkTreasuryBalance(dependencies, {
      treasuryId: treasury.id,
      role: 'cron-treasury-monitor',
      operationId: 'op-2',
      actor: { type: 'cron', id: 'treasury-monitor' },
    });

    expect(result.reading.kind).toBe('unavailable');
    expect(dependencies.balanceObservations.record).not.toHaveBeenCalled();
    expect(dependencies.treasuries.recordCheckFailure).toHaveBeenCalledOnce();
    expect(dependencies.treasuries.recordCheckSuccess).not.toHaveBeenCalled();
  });

  it('enforces authorization inside the application service', async () => {
    const dependencies = deps({});
    await expect(
      checkTreasuryBalance(dependencies, {
        treasuryId: treasury.id,
        role: 'read-only',
        operationId: 'op-3',
        actor: { type: 'api_credential', id: 'cred-ro' },
      }),
    ).rejects.toBeInstanceOf(ChainBankError);
  });
});
