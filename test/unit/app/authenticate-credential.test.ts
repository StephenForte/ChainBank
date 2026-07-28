import { describe, expect, it, vi } from 'vitest';
import {
  authenticateCredential,
  extractBearerToken,
} from '../../../src/app/auth/authenticate-credential.js';
import type { ApiCredentialRepository } from '../../../src/app/ports.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { generateApiToken, hashApiToken } from '../../../src/shared/api-token.js';
import { createFixedClock } from '../../support/clock.js';

function repositoryStub(
  find: ApiCredentialRepository['findByTokenHash'],
): ApiCredentialRepository {
  return {
    findByTokenHash: find,
    touchLastUsed: vi.fn(() => Promise.resolve(undefined)),
  };
}

describe('extractBearerToken', () => {
  it('extracts a bearer token', () => {
    expect(extractBearerToken('Bearer secret-token')).toBe('secret-token');
  });

  it('rejects missing or malformed headers with the same auth category', () => {
    for (const header of [undefined, '', 'Basic abc', 'Bearer']) {
      try {
        extractBearerToken(header);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ChainBankError);
        expect((error as ChainBankError).code).toBe('AUTHENTICATION_REQUIRED');
      }
    }
  });
});

describe('authenticateCredential', () => {
  const clock = createFixedClock();
  const generated = generateApiToken();

  it('resolves a valid credential and records last-used', async () => {
    const apiCredentials = repositoryStub((tokenHash) => {
      expect(tokenHash).toBe(hashApiToken(generated.token));
      return Promise.resolve({
        id: 'cred-1',
        name: 'operator-local',
        role: 'operator',
        enabled: true,
        revokedAt: undefined,
      });
    });

    const actor = await authenticateCredential({ apiCredentials, clock }, generated.token);

    expect(actor).toEqual({
      credentialId: 'cred-1',
      name: 'operator-local',
      role: 'operator',
    });
    expect(apiCredentials.touchLastUsed).toHaveBeenCalledWith('cred-1', clock.now());
  });

  it('returns the same public message for unknown and disabled credentials', async () => {
    const unknown = repositoryStub(() => Promise.resolve(undefined));
    const disabled = repositoryStub(() =>
      Promise.resolve({
        id: 'cred-2',
        name: 'disabled',
        role: 'operator',
        enabled: false,
        revokedAt: undefined,
      }),
    );

    const unknownError = await authenticateCredential({ apiCredentials: unknown, clock }, 'nope').catch(
      (error: unknown) => error,
    );
    const disabledError = await authenticateCredential(
      { apiCredentials: disabled, clock },
      generated.token,
    ).catch((error: unknown) => error);

    expect(unknownError).toBeInstanceOf(ChainBankError);
    expect(disabledError).toBeInstanceOf(ChainBankError);
    expect((unknownError as ChainBankError).publicMessage).toBe(
      (disabledError as ChainBankError).publicMessage,
    );
  });
});
