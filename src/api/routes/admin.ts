import type { AppInstance } from '../types.js';
import { sendTestEmail } from '../../app/admin/send-test-email.js';
import type { Container } from '../../container.js';
import { ChainBankError } from '../../domain/errors.js';
import { requireActor } from '../plugins/authentication.js';

export function registerAdminRoutes(app: AppInstance, container: Container): void {
  /**
   * Sends the configured operator recipients a test message.
   *
   * The body must be empty. Recipients come from validated configuration, so
   * there is no request field through which a caller could redirect mail.
   */
  app.post(
    '/v1/admin/email/test',
    {
      preHandler: app.authenticate,
      schema: {
        body: { type: 'object', additionalProperties: false, properties: {}, nullable: true },
      },
    },
    async (request) => {
      const actor = requireActor(request);
      const { config, emailSender } = container;

      if (emailSender === undefined || config.email === undefined) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          'This process was started without email configuration',
          { publicMessage: 'Email is not configured for this service.' },
        );
      }

      const result = await sendTestEmail(
        {
          emailSender,
          auditEvents: container.repositories.auditEvents,
          clock: container.clock,
        },
        {
          role: actor.role,
          operationId: request.id,
          actorId: actor.credentialId,
          sourceIp: request.ip,
          recipients: config.email.operatorRecipients,
          environment: config.app.environment,
          chainDisplayName: config.chain.displayName,
          treasuryAddressDisplay: config.treasury.address,
          dashboardUrl: config.app.publicBaseUrl,
        },
      );

      return {
        data: {
          // The recipient list itself is not echoed back; the count is enough
          // to confirm the action without restating configured addresses.
          recipientCount: result.recipientCount,
          sentAt: result.sentAt.toISOString(),
          provider: config.email.provider,
        },
      };
    },
  );
}
