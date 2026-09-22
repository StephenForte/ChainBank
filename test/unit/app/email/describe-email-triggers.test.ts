import { describe, expect, it } from 'vitest';
import { describeEmailTriggers } from '../../../../src/app/email/describe-email-triggers.js';
import type { EmailConfig } from '../../../../src/config/index.js';
import type { Treasury } from '../../../../src/app/ports.js';

const API_KEY = 're_thisMustNotAppearInOutput12345';

const email: EmailConfig = {
  provider: 'resend',
  apiKey: API_KEY,
  fromAddress: 'alerts@example.com',
  operatorRecipients: ['one@example.com', 'two@example.com'],
};

describe('describeEmailTriggers', () => {
  it('lists one row per enabled treasury plus the fixed triggers, and never the API key', () => {
    const description = describeEmailTriggers({
      treasuries: [
        treasury({
          id: 'sep-public',
          chainId: 11_155_111,
          displayName: 'Ethereum Sepolia',
          kind: 'external',
          address: '0x1111111111111111111111111111111111111111',
          warning: 111n,
        }),
        treasury({
          id: 'sep-private',
          chainId: 11_155_111,
          displayName: 'Ethereum Sepolia',
          kind: 'operational',
          address: '0x2222222222222222222222222222222222222222',
          warning: 211n,
          policy: { minimumBalanceWei: 555n, targetBalanceWei: 666n, maximumTopUpWei: 777n },
        }),
        treasury({
          id: 'base-public',
          chainId: 84_532,
          displayName: 'Base Sepolia',
          kind: 'external',
          address: '0x3333333333333333333333333333333333333333',
          warning: 311n,
        }),
        treasury({
          id: 'base-private',
          chainId: 84_532,
          displayName: 'Base Sepolia',
          kind: 'operational',
          address: '0x4444444444444444444444444444444444444444',
          warning: 411n,
          policy: { minimumBalanceWei: 855n, targetBalanceWei: 866n, maximumTopUpWei: 877n },
        }),
        treasury({
          id: 'disabled',
          chainId: 11_155_111,
          displayName: 'Ethereum Sepolia',
          kind: 'external',
          address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
          warning: 999n,
          enabled: false,
        }),
      ],
      reminderIntervalHours: 24,
      reconcileFailureAlertThreshold: 3,
      email,
    });

    const treasuryRows = description.triggers.filter((row) => row.trigger === 'Treasury balance');
    expect(treasuryRows).toHaveLength(4);
    expect(description.triggers).toHaveLength(4 + 6);
    expect(description.recipients).toEqual(['one@example.com', 'two@example.com']);
    expect(description.fromAddress).toBe('alerts@example.com');
    expect(description.provider).toBe('resend');

    for (const row of description.triggers) {
      expect(row.recipients).toEqual(['one@example.com', 'two@example.com']);
    }

    expect(treasuryRows[0]?.scope).toContain('Ethereum Sepolia (11155111)');
    expect(treasuryRows[0]?.scope).toContain('Public');
    expect(treasuryRows[0]?.scope).toContain('0x1111111111111111111111111111111111111111');
    expect(treasuryRows[0]?.condition).toContain('warning 111 wei');
    expect(treasuryRows[0]?.condition).toContain('critical 222 wei');
    expect(treasuryRows[0]?.condition).toContain('recovery 333 wei');
    expect(treasuryRows[0]?.condition).toContain('minimum reserve 444 wei');
    expect(treasuryRows[0]?.condition).not.toContain('policy minimum');

    expect(treasuryRows[1]?.scope).toContain('Private');
    expect(treasuryRows[1]?.condition).toContain('policy minimum 555 wei');
    expect(treasuryRows[1]?.condition).toContain('target 666 wei');
    expect(treasuryRows[1]?.condition).toContain('maximum top-up 777 wei');

    expect(treasuryRows[2]?.scope).toContain('Base Sepolia (84532)');
    expect(treasuryRows[3]?.scope).toContain('Private');
    expect(treasuryRows[3]?.condition).toContain('policy minimum 855 wei');

    expect(description.triggers.map((row) => `${row.trigger}|${row.scope}`)).toEqual([
      expect.stringContaining('Treasury balance|Ethereum Sepolia'),
      expect.stringContaining('Treasury balance|Ethereum Sepolia'),
      expect.stringContaining('Treasury balance|Base Sepolia'),
      expect.stringContaining('Treasury balance|Base Sepolia'),
      'Reconciliation failure|Enabled treasuries',
      'Unresolved alert reminder|Open treasury balance alerts',
      'Funding unavailable (reserve)|Enabled treasuries',
      'Critical finding|unexplained_outgoing_transfer',
      'Critical finding|outgoing_scan_incomplete',
      'Test email|On demand',
    ]);
    expect(description.triggers[4]?.condition).toBe('After 3 consecutive failed reconciliation runs');
    expect(description.triggers[5]?.condition).toBe(
      'Every 24 hours while a treasury balance alert stays open',
    );

    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('re_');
    expect(serialized).not.toContain('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead');
  });

  it('reports the unresolved reminder as off when the interval is 0 hours', () => {
    const description = describeEmailTriggers({
      treasuries: [],
      reminderIntervalHours: 0,
      reconcileFailureAlertThreshold: 3,
      email: {
        provider: 'log-only',
        fromAddress: 'alerts@example.com',
        operatorRecipients: ['one@example.com'],
      },
    });
    const reminder = description.triggers.find((row) => row.trigger === 'Unresolved alert reminder');
    expect(reminder?.condition).toBe('Off (interval is 0 hours)');
    expect(description.provider).toBe('log-only');
  });
});

function treasury(input: {
  readonly id: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly kind: 'external' | 'operational';
  readonly address: string;
  readonly warning: bigint;
  readonly enabled?: boolean;
  readonly policy?: {
    readonly minimumBalanceWei: bigint;
    readonly targetBalanceWei: bigint;
    readonly maximumTopUpWei: bigint;
  };
}): Treasury {
  return {
    id: input.id,
    chain: {
      id: `chain-${String(input.chainId)}`,
      slug: 'chain',
      chainId: input.chainId,
      displayName: input.displayName,
      nativeSymbol: 'ETH',
      explorerBaseUrl: 'https://explorer.example.test',
    },
    address: input.address,
    addressDisplay: input.address,
    kind: input.kind,
    policy: input.policy,
    thresholds: {
      warningBalanceWei: input.warning,
      criticalBalanceWei: 222n,
      recoveryBalanceWei: 333n,
      minimumReserveWei: 444n,
    },
    status: 'unknown',
    lastObservedBalanceWei: undefined,
    lastObservedAt: undefined,
    lastCheckedAt: undefined,
    lastCheckErrorCode: undefined,
    lastOutgoingScanBlock: undefined,
    lastOutgoingScanAt: undefined,
    lastOutgoingScanNonce: undefined,
    enabled: input.enabled ?? true,
  };
}
