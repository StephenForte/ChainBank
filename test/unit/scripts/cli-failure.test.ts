import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatCliFailure, type CliFailureFormat } from '../../../scripts/cli-failure.js';
import { ChainBankError } from '../../../src/domain/errors.js';

const PUBLIC_MESSAGE = 'The service is misconfigured.';
const SQLSTATE = '23505';
const CONNECTION_URL = 'postgres://chainbank:s3cret@db.internal/x';

const USER_FORMAT: CliFailureFormat = {
  summary: 'Failed to create dashboard user',
  chainBankHeadline: 'publicMessage',
  otherErrorHeadline: 'message',
};

const CREDENTIAL_FORMAT: CliFailureFormat = {
  summary: 'Failed to issue credential',
  chainBankHeadline: 'message',
  otherErrorHeadline: 'describeUnknown',
};

describe('formatCliFailure', () => {
  it('keeps the public message and includes the SQLSTATE on a second line', () => {
    // severity is required: describeErrorChain treats code+severity as a driver
    // error and otherwise drops the SQLSTATE. detail alone is not enough.
    const error = new ChainBankError('INVALID_CONFIGURATION', 'constraint rejected the row', {
      publicMessage: PUBLIC_MESSAGE,
      cause: {
        code: SQLSTATE,
        severity: 'ERROR',
        detail: 'Key (email)=(x@example.com) already exists',
      },
    });

    const lines = formatCliFailure(error, USER_FORMAT).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`Failed to create dashboard user: ${PUBLIC_MESSAGE}`);
    expect(lines[1]).toContain(SQLSTATE);
  });

  it('does not print a driver message that carries a connection string', () => {
    const driver = Object.assign(new Error(`connect failed: ${CONNECTION_URL}`), {
      severity: 'FATAL',
      code: '08006',
    });
    const wrapped = new DrizzleQueryError('select 1', [], driver);
    const error = new ChainBankError(
      'DATABASE_UNAVAILABLE',
      'Database operation "dashboard_users.findByEmail" failed',
      {
        publicMessage: 'A required dependency is currently unavailable.',
        cause: wrapped,
      },
    );

    expect(driver.message).toContain(CONNECTION_URL);

    const output = formatCliFailure(error, USER_FORMAT);

    expect(output).not.toContain('s3cret');
    expect(output).not.toContain('postgres://');
  });

  it('does not put a drizzle query on the issue-credential headline', () => {
    const driver = Object.assign(new Error(`connect failed: ${CONNECTION_URL}`), {
      severity: 'FATAL',
      code: '08006',
    });
    const wrapped = new DrizzleQueryError(
      'insert into "api_credentials" values ($1)',
      ['s3cret-param'],
      driver,
    );

    expect(wrapped.message).toContain('s3cret-param');
    expect(driver.message).toContain(CONNECTION_URL);

    const output = formatCliFailure(wrapped, CREDENTIAL_FORMAT);

    expect(output.split('\n')[0]).toBe('Failed to issue credential: DrizzleQueryError');
    expect(output).not.toContain('s3cret');
    expect(output).not.toContain('postgres://');
    expect(output).not.toContain('insert into');
  });

  it('formats a plain Error and a non-Error without throwing', () => {
    const plain = formatCliFailure(new Error('disk full'), USER_FORMAT);
    const thrown = formatCliFailure(42, USER_FORMAT);

    expect(plain.split('\n')).toEqual([
      'Failed to create dashboard user: disk full',
      'Cause: Error: disk full',
    ]);
    expect(thrown.split('\n')).toEqual([
      'Failed to create dashboard user: Non-error value thrown',
      'Cause: Non-error value thrown',
    ]);
  });

  it("keeps issue-credential's ChainBankError headline on error.message", () => {
    const error = new ChainBankError(
      'DATABASE_UNAVAILABLE',
      'Database operation "api_credentials.insert" failed',
      {
        publicMessage: 'A required dependency is currently unavailable.',
      },
    );

    const [headline] = formatCliFailure(error, CREDENTIAL_FORMAT).split('\n');

    expect(headline).toBe('Failed to issue credential: Database operation "api_credentials.insert" failed');
  });
});
