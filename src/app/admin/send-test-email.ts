import { assertPermission, type Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Clock } from '../../domain/ports.js';
import { renderTestEmail } from '../email/test-email-template.js';
import type { AuditEventRepository, EmailSender } from '../ports.js';

export interface SendTestEmailDependencies {
  readonly emailSender: EmailSender;
  readonly auditEvents: AuditEventRepository;
  readonly clock: Clock;
}

export interface SendTestEmailInput {
  readonly role: Role;
  readonly operationId: string;
  readonly actorId: string;
  readonly sourceIp: string | undefined;
  readonly recipients: readonly string[];
  readonly environment: string;
  readonly chainDisplayName: string;
  readonly treasuryAddressDisplay: string;
  readonly dashboardUrl: string;
}

export interface SendTestEmailResult {
  readonly recipientCount: number;
  readonly sentAt: Date;
  readonly providerMessageId: string | undefined;
}

/**
 * Sends the operator a test message to prove the alert delivery path works.
 *
 * Recipients come from validated configuration, never from the request body, so
 * this endpoint cannot be used to send mail to an arbitrary address.
 */
export async function sendTestEmail(
  dependencies: SendTestEmailDependencies,
  input: SendTestEmailInput,
): Promise<SendTestEmailResult> {
  assertPermission(input.role, 'email:test');

  const sentAt = dependencies.clock.now();
  const message = renderTestEmail({
    environment: input.environment,
    chainDisplayName: input.chainDisplayName,
    treasuryAddressDisplay: input.treasuryAddressDisplay,
    dashboardUrl: input.dashboardUrl,
    sentAt,
    recipients: input.recipients,
  });

  const result = await dependencies.emailSender.send(message);

  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.actorId,
    action: result.kind === 'sent' ? 'email.test.sent' : 'email.test.failed',
    entityType: 'email',
    entityId: undefined,
    requestId: input.operationId,
    sourceIp: input.sourceIp,
    // Recipient addresses and message bodies are deliberately excluded; only
    // the shape of the attempt is recorded.
    metadata: {
      recipientCount: input.recipients.length,
      outcome: result.kind,
      ...(result.kind === 'failed' ? { errorCode: result.errorCode } : {}),
    },
  });

  if (result.kind === 'failed') {
    throw new ChainBankError(result.errorCode, `Test email could not be delivered: ${result.reason}`, {
      publicMessage: 'The email provider could not deliver the test message.',
      context: { reason: result.reason },
    });
  }

  return {
    recipientCount: input.recipients.length,
    sentAt,
    providerMessageId: result.providerMessageId,
  };
}
