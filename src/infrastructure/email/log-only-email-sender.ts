import type { EmailMessage, EmailSender, EmailSendResult } from '../../app/ports.js';
import type { Logger } from '../../observability/logger.js';

/**
 * Local development sender.
 *
 * Records that a message would have been sent, along with its subject and
 * recipient count, without contacting a provider or requiring an API key. The
 * body is not logged, so this adapter cannot become a leak once alert emails
 * begin carrying operational detail.
 */
export function createLogOnlyEmailSender(logger: Logger): EmailSender {
  return {
    send(message: EmailMessage): Promise<EmailSendResult> {
      logger.info(
        { subject: message.subject, recipientCount: message.to.length },
        'Email suppressed: provider is log-only',
      );
      return Promise.resolve({ kind: 'sent', providerMessageId: undefined });
    },
  };
}
