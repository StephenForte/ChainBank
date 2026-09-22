import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  EmailDeliveryRepository,
  EmailMessage,
  EmailSender,
  EmailSendResult,
  RecordEmailDeliveryInput,
} from '../../../../src/app/ports.js';
import { describeErrorChain } from '../../../../src/domain/errors.js';
import { createRecordingEmailSender } from '../../../../src/infrastructure/email/recording-email-sender.js';
import { createLogger } from '../../../../src/observability/logger.js';
import { createFixedClock } from '../../../support/clock.js';

const SECRET = 're_fakeSecretKey123';

const message: EmailMessage = {
  to: ['operator@example.com'],
  subject: 'Treasury critical',
  text: 'balance body',
  html: '<p>balance body</p>',
  kind: 'treasury_critical',
  relatedEntity: { type: 'treasury', id: 'treasury-1' },
  correlationId: 'op-1',
};

describe('recording email sender', () => {
  it('records one sent row after the provider answers, and returns that result', async () => {
    const result: EmailSendResult = { kind: 'sent', providerMessageId: 'prov-1' };
    const { rows, repository } = createDeliveries();
    let recordedBeforeSend = false;
    const inner: EmailSender = {
      send() {
        recordedBeforeSend = rows.length > 0;
        return Promise.resolve(result);
      },
    };
    const { sender } = createSender(inner, repository);

    await expect(sender.send(message)).resolves.toBe(result);
    expect(recordedBeforeSend).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      sentAt: new Date('2026-07-26T12:00:00.000Z'),
      kind: 'treasury_critical',
      recipients: ['operator@example.com'],
      subject: 'Treasury critical',
      status: 'sent',
      providerMessageId: 'prov-1',
      errorCode: undefined,
      errorSummary: undefined,
      relatedEntityType: 'treasury',
      relatedEntityId: 'treasury-1',
      correlationId: 'op-1',
      serviceRole: 'web',
    });
    expect(rows[0]).not.toHaveProperty('text');
    expect(rows[0]).not.toHaveProperty('html');
    expect(JSON.stringify(rows[0])).not.toContain('balance body');
  });

  it('records a failed result with the provider code and reason', async () => {
    const result: EmailSendResult = {
      kind: 'failed',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
      reason: 'mailbox rejected',
    };
    const { rows, repository } = createDeliveries();
    const inner: EmailSender = { send: () => Promise.resolve(result) };
    const { sender } = createSender(inner, repository);

    await expect(sender.send(message)).resolves.toBe(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
      errorSummary: 'mailbox rejected',
      providerMessageId: undefined,
    });
  });

  it('records a failed result whose reason is missing at runtime and returns it unchanged', async () => {
    const result = {
      kind: 'failed',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
    } as EmailSendResult;
    const { rows, repository } = createDeliveries();
    const { sender } = createSender({ send: () => Promise.resolve(result) }, repository);

    await expect(sender.send(message)).resolves.toBe(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
      errorSummary: '',
      providerMessageId: undefined,
    });
  });

  it('records a thrown inner error as failed and rethrows that same error', async () => {
    const error = new Error('smtp down');
    const { rows, repository } = createDeliveries();
    const inner: EmailSender = {
      send() {
        return Promise.reject(error);
      },
    };
    const { sender } = createSender(inner, repository);

    await expect(sender.send(message)).rejects.toBe(error);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'INTERNAL_ERROR',
      errorSummary: describeErrorChain(error),
      providerMessageId: undefined,
    });
  });

  it('does not change the result when the repository throws', async () => {
    const result: EmailSendResult = { kind: 'sent', providerMessageId: 'prov-9' };
    const failure = new Error('postgres down');
    const repository: EmailDeliveryRepository = {
      record() {
        return Promise.reject(failure);
      },
      list() {
        return Promise.resolve({ items: [], total: 0 });
      },
    };
    const { sender, lines } = createSender({ send: () => Promise.resolve(result) }, repository);

    await expect(sender.send(message)).resolves.toBe(result);
    const logged = lines().join('');
    expect(logged).toContain('Email delivery could not be recorded');
    expect(logged).toContain(describeErrorChain(failure));
  });

  it('records a missing kind as unknown', async () => {
    const withoutKind: EmailMessage = {
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    };
    const { rows, repository } = createDeliveries();
    const { sender } = createSender(
      { send: () => Promise.resolve({ kind: 'sent', providerMessageId: undefined }) },
      repository,
    );

    await sender.send(withoutKind);
    expect(rows[0]?.kind).toBe('unknown');
  });

  it('stores a failure whose message embeds a Resend key without the key', async () => {
    const error = new Error(`provider rejected ${SECRET}`);
    const { rows, repository } = createDeliveries();
    const thrown: EmailSender = {
      send() {
        return Promise.reject(error);
      },
    };
    const { sender: throwingSender } = createSender(thrown, repository);
    await expect(throwingSender.send(message)).rejects.toBe(error);
    expect(rows[0]?.errorSummary).toContain('[redacted]');
    expect(JSON.stringify(rows[0])).not.toContain(SECRET);
    expect(JSON.stringify(rows[0])).not.toContain('re_');

    const rejected: EmailSendResult = {
      kind: 'failed',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
      reason: `nope ${SECRET}`,
    };
    const second = createDeliveries();
    const { sender: failingSender } = createSender(
      { send: () => Promise.resolve(rejected) },
      second.repository,
    );
    await expect(failingSender.send(message)).resolves.toBe(rejected);
    expect(second.rows[0]?.errorCode).toBe('EMAIL_PROVIDER_REJECTED');
    expect(second.rows[0]?.errorSummary).toBe('nope [redacted]');
    expect(JSON.stringify(second.rows[0])).not.toContain(SECRET);
    expect(JSON.stringify(second.rows[0])).not.toContain('re_');
  });
});

function createDeliveries(): {
  readonly rows: RecordEmailDeliveryInput[];
  readonly repository: EmailDeliveryRepository;
} {
  const rows: RecordEmailDeliveryInput[] = [];
  return {
    rows,
    repository: {
      record(input) {
        rows.push(input);
        return Promise.resolve();
      },
      list() {
        return Promise.resolve({ items: [], total: 0 });
      },
    },
  };
}

function createSender(inner: EmailSender, deliveries: EmailDeliveryRepository) {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  const lines = () => [Buffer.concat(chunks).toString('utf8')];
  const logger = createLogger({
    level: 'error',
    serviceRole: 'web',
    environment: 'test',
    destination,
  });
  const sender = createRecordingEmailSender({
    inner,
    deliveries,
    logger,
    clock: createFixedClock(),
    serviceRole: 'web',
  });
  return { sender, lines };
}
