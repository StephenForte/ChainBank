import {
  UNKNOWN_EMAIL_DELIVERY_KIND,
  type EmailDeliveryRepository,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
  type RecordEmailDeliveryInput,
} from '../../app/ports.js';
import type { Clock } from '../../domain/ports.js';
import { describeErrorChain, isChainBankError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

export interface CreateRecordingEmailSenderOptions {
  readonly inner: EmailSender;
  readonly deliveries: EmailDeliveryRepository;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Which process attempted the send (`web`, `treasury-monitor`, `cron-reconciler`). */
  readonly serviceRole: string;
}

/**
 * Resend API keys are `re_` plus a token. `describeErrorChain` renders
 * `Error.message`, so a provider exception that embedded the key would be
 * stored unless it is stripped here. The Resend adapter already returns
 * `error.name` or a static sentence; this is the second line.
 */
const RESEND_KEY_PATTERN = /re_[A-Za-z0-9_-]+/g;

/**
 * Wraps the process email sender and writes one `email_deliveries` row per
 * attempt, after the inner sender has answered (C35).
 *
 * The inner result is returned unchanged in every case, including when the
 * insert throws. Recording is an observation. It is not part of the alert
 * state machine: a Postgres outage must not turn a delivered critical email
 * into a retry, or a failed one into a success.
 */
export function createRecordingEmailSender(options: CreateRecordingEmailSenderOptions): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const sentAt = options.clock.now();
      let result: EmailSendResult;
      try {
        result = await options.inner.send(message);
      } catch (error) {
        await recordSafely(options, () => deliveryFromThrow(message, sentAt, options.serviceRole, error));
        throw error;
      }
      await recordSafely(options, () => deliveryFromResult(message, sentAt, options.serviceRole, result));
      return result;
    },
  };
}

export function redactEmailProviderSecrets(value: string | undefined): string {
  return (value ?? '').replace(RESEND_KEY_PATTERN, '[redacted]');
}

function deliveryFromResult(
  message: EmailMessage,
  sentAt: Date,
  serviceRole: string,
  result: EmailSendResult,
): RecordEmailDeliveryInput {
  const base = deliveryBase(message, sentAt, serviceRole);
  if (result.kind === 'sent') {
    return {
      ...base,
      status: 'sent',
      providerMessageId: result.providerMessageId,
      errorCode: undefined,
      errorSummary: undefined,
    };
  }
  return {
    ...base,
    status: 'failed',
    providerMessageId: undefined,
    errorCode: result.errorCode,
    errorSummary: redactEmailProviderSecrets(result.reason),
  };
}

function deliveryFromThrow(
  message: EmailMessage,
  sentAt: Date,
  serviceRole: string,
  error: unknown,
): RecordEmailDeliveryInput {
  return {
    ...deliveryBase(message, sentAt, serviceRole),
    status: 'failed',
    providerMessageId: undefined,
    errorCode: thrownErrorCode(error),
    errorSummary: redactEmailProviderSecrets(describeErrorChain(error)),
  };
}

function deliveryBase(
  message: EmailMessage,
  sentAt: Date,
  serviceRole: string,
): Omit<RecordEmailDeliveryInput, 'status' | 'providerMessageId' | 'errorCode' | 'errorSummary'> {
  return {
    sentAt,
    kind: message.kind ?? UNKNOWN_EMAIL_DELIVERY_KIND,
    recipients: [...message.to],
    subject: message.subject,
    relatedEntityType: message.relatedEntity?.type,
    relatedEntityId: message.relatedEntity?.id,
    correlationId: message.correlationId,
    serviceRole,
  };
}

function thrownErrorCode(error: unknown): string {
  if (isChainBankError(error)) {
    return error.code;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return redactEmailProviderSecrets(error.code);
  }
  return 'INTERNAL_ERROR';
}

async function recordSafely(
  options: CreateRecordingEmailSenderOptions,
  build: () => RecordEmailDeliveryInput,
): Promise<void> {
  try {
    await options.deliveries.record(build());
  } catch (error) {
    try {
      options.logger.error({ detail: describeErrorChain(error) }, 'Email delivery could not be recorded');
    } catch {
      // The log line is diagnostic. It must not replace the send result.
    }
  }
}
