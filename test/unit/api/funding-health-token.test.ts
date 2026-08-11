import { describe, expect, it } from 'vitest';
import { assertFundingHealthToken } from '../../../src/api/routes/health.js';
import { ChainBankError } from '../../../src/domain/errors.js';

function fakeRequest(authorization: string | undefined): {
  headers: { authorization: string | undefined };
} {
  return { headers: { authorization } };
}

describe('assertFundingHealthToken', () => {
  it('accepts a matching bearer token', () => {
    expect(() =>
      assertFundingHealthToken(fakeRequest('Bearer secret-token-value') as never, 'secret-token-value'),
    ).not.toThrow();
  });

  it('rejects when FUNDING_HEALTH_TOKEN is unset', () => {
    expect(() => assertFundingHealthToken(fakeRequest('Bearer anything') as never, undefined)).toThrow(
      ChainBankError,
    );
  });

  it('rejects a mismatched token with INVALID_CREDENTIAL', () => {
    try {
      assertFundingHealthToken(fakeRequest('Bearer wrong') as never, 'expected-token');
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('INVALID_CREDENTIAL');
    }
  });

  it('rejects a missing Authorization header', () => {
    try {
      assertFundingHealthToken(fakeRequest(undefined) as never, 'expected-token');
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ChainBankError);
      expect((error as ChainBankError).code).toBe('AUTHENTICATION_REQUIRED');
    }
  });
});
