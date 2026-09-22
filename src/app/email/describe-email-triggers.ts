import type { EmailConfig } from '../../config/index.js';
import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { treasuryKindDisplayName } from '../../domain/treasury/treasury-kind.js';
import type { Treasury, TreasuryRepository } from '../ports.js';

export interface EmailTriggerRow {
  readonly trigger: string;
  readonly scope: string;
  readonly condition: string;
  readonly recipients: readonly string[];
}

export interface EmailTriggersDescription {
  readonly triggers: readonly EmailTriggerRow[];
  readonly recipients: readonly string[];
  readonly fromAddress: string;
  readonly provider: 'resend' | 'log-only';
}

export interface DescribeEmailTriggersInput {
  readonly treasuries: readonly Treasury[];
  /** Hours from `ALERT_REMINDER_INTERVAL_HOURS`. Zero means the reminder is off. */
  readonly reminderIntervalHours: number;
  readonly reconcileFailureAlertThreshold: number;
  /**
   * Full email config so a caller can pass the loaded object. Only
   * `provider`, `fromAddress`, and `operatorRecipients` are copied out.
   * `apiKey` is never read onto the result.
   */
  readonly email: EmailConfig;
}

export interface ListEmailTriggersDependencies {
  readonly treasuries: TreasuryRepository;
  readonly email: EmailConfig | undefined;
  readonly reminderIntervalMs: number;
  readonly reconcileFailureAlertThreshold: number;
}

/**
 * What can send mail today, derived from enabled treasury rows and config (C35).
 * No new storage. Disabled treasuries are omitted.
 */
export function describeEmailTriggers(input: DescribeEmailTriggersInput): EmailTriggersDescription {
  const recipients = [...input.email.operatorRecipients];
  const treasuryRows = input.treasuries
    .filter((treasury) => treasury.enabled)
    .map((treasury) => ({
      trigger: 'Treasury balance',
      scope: treasuryScope(treasury),
      condition: treasuryCondition(treasury),
      recipients,
    }));

  const fixed: readonly EmailTriggerRow[] = [
    {
      trigger: 'Reconciliation failure',
      scope: 'Enabled treasuries',
      condition: `After ${String(input.reconcileFailureAlertThreshold)} consecutive failed reconciliation runs`,
      recipients,
    },
    {
      trigger: 'Unresolved alert reminder',
      scope: 'Open treasury balance alerts',
      condition:
        input.reminderIntervalHours === 0
          ? 'Off (interval is 0 hours)'
          : `Every ${String(input.reminderIntervalHours)} hours while a treasury balance alert stays open`,
      recipients,
    },
    {
      trigger: 'Funding unavailable (reserve)',
      scope: 'Enabled treasuries',
      condition: 'A transfer would spend the treasury below its minimum reserve',
      recipients,
    },
    {
      trigger: 'Critical finding',
      scope: 'unexplained_outgoing_transfer',
      condition: 'Always on',
      recipients,
    },
    {
      trigger: 'Critical finding',
      scope: 'outgoing_scan_incomplete',
      condition: 'Always on',
      recipients,
    },
    {
      trigger: 'Test email',
      scope: 'On demand',
      condition: 'Sent when an operator requests a test message',
      recipients,
    },
  ];

  return {
    triggers: [...treasuryRows, ...fixed],
    recipients,
    fromAddress: input.email.fromAddress,
    provider: input.email.provider,
  };
}

export async function listEmailTriggers(
  dependencies: ListEmailTriggersDependencies,
  input: { readonly role: Role },
): Promise<EmailTriggersDescription> {
  assertPermission(input.role, 'alert:read');
  if (dependencies.email === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'This process was started without email configuration',
      {
        publicMessage: 'Email is not configured for this service.',
      },
    );
  }
  const treasuries = await dependencies.treasuries.listEnabled();
  return describeEmailTriggers({
    treasuries,
    reminderIntervalHours: dependencies.reminderIntervalMs / (60 * 60 * 1000),
    reconcileFailureAlertThreshold: dependencies.reconcileFailureAlertThreshold,
    email: dependencies.email,
  });
}

function treasuryScope(treasury: Treasury): string {
  return `${treasury.chain.displayName} (${String(treasury.chain.chainId)}) · ${treasuryKindDisplayName(treasury.kind)} · ${treasury.addressDisplay}`;
}

function treasuryCondition(treasury: Treasury): string {
  const thresholds = treasury.thresholds;
  const ladder = [
    `warning ${thresholds.warningBalanceWei.toString()} wei`,
    `critical ${thresholds.criticalBalanceWei.toString()} wei`,
    `recovery ${thresholds.recoveryBalanceWei.toString()} wei`,
    `minimum reserve ${thresholds.minimumReserveWei.toString()} wei`,
  ];
  if (treasury.kind !== 'operational') {
    return ladder.join('; ');
  }
  const policy = treasury.policy;
  if (policy === undefined) {
    return `${ladder.join('; ')}; policy row missing`;
  }
  return [
    ...ladder,
    `policy minimum ${policy.minimumBalanceWei.toString()} wei`,
    `target ${policy.targetBalanceWei.toString()} wei`,
    `maximum top-up ${policy.maximumTopUpWei.toString()} wei`,
  ].join('; ');
}
