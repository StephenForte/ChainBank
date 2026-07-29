import { getAddress, isAddress } from 'viem';
import { ChainBankError } from '../../domain/errors.js';

export interface NormalizedManagedAddress {
  /** Lowercase form stored and used for uniqueness. */
  readonly address: string;
  /** EIP-55 checksummed form for display. */
  readonly addressDisplay: string;
}

/**
 * Validates and normalizes a managed-wallet address.
 *
 * Managed wallets are destination allowlist entries only — callers must never
 * supply or persist private-key material for them.
 */
export function normalizeManagedAddress(raw: string): NormalizedManagedAddress {
  const trimmed = raw.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new ChainBankError('INVALID_ADDRESS', `Address "${trimmed}" is not a valid EVM address`, {
      publicMessage: 'The wallet address is not a valid EVM address.',
    });
  }

  const addressDisplay = getAddress(trimmed);
  return {
    address: addressDisplay.toLowerCase(),
    addressDisplay,
  };
}
