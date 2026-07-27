import { Resend } from 'resend';
import type { EmailMessage, EmailSender, EmailSendResult } from '../../app/ports.js';
import { describeUnknownError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

export interface CreateResendEmailSenderOptions {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly logger: Logger;
}

/**
 * Resend adapter.
 *
 * Failures are returned as values rather than thrown, because a send failure is
 * an expected operational condition that the caller reports on. The API key is
 * held only in the client closure and never enters a log line or a result.
 */
export function createResendEmailSender(options: CreateResendEmailSenderOptions): EmailSender {
  const client = new Resend(options.apiKey);

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      try {
        const response = await client.emails.send({
          from: options.fromAddress,
          to: [...message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        });

        if (response.error !== null) {
          options.logger.error(
            { recipientCount: message.to.length, providerError: response.error.name },
            'Email provider rejected the message',
          );
          return {
            kind: 'failed',
            errorCode: 'EMAIL_PROVIDER_REJECTED',
            reason: response.error.name,
          };
        }

        return { kind: 'sent', providerMessageId: response.data?.id };
      } catch (error) {
        options.logger.error(
          { recipientCount: message.to.length, detail: describeUnknownError(error) },
          'Email provider request failed',
        );
        return {
          kind: 'failed',
          errorCode: 'EMAIL_PROVIDER_UNAVAILABLE',
          reason: 'The email provider could not be reached.',
        };
      }
    },
  };
}
