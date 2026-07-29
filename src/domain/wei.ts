import { ChainBankError } from './errors.js';

export const WEI_DECIMALS = 18;
export const WEI_PER_ETHER = 10n ** BigInt(WEI_DECIMALS);

/** Widest value representable by the numeric(78,0) columns that store wei. */
const MAX_NUMERIC_78 = 10n ** 78n - 1n;

const DECIMAL_ETHER_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const INTEGER_PATTERN = /^\d+$/;

/**
 * Parses an operator-supplied decimal ETH string into wei.
 *
 * Decimal strings are configuration and UI input only. This is the single
 * validated boundary where they become integers; no other layer may parse them.
 */
export function parseEtherToWei(value: string, fieldName: string): bigint {
  const trimmed = value.trim();
  // Accept ".25" as well as "0.25" — common when operators type fractional ETH.
  const normalized = trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
  const match = DECIMAL_ETHER_PATTERN.exec(normalized);
  if (match === null) {
    throw new ChainBankError(
      'INVALID_AMOUNT',
      `${fieldName} must be a non-negative decimal ETH string, received "${trimmed}"`,
      { publicMessage: `${fieldName} must be a non-negative decimal amount.` },
    );
  }

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > WEI_DECIMALS) {
    throw new ChainBankError(
      'INVALID_AMOUNT',
      `${fieldName} has ${String(fraction.length)} decimal places, exceeding ${String(WEI_DECIMALS)}`,
      { publicMessage: `${fieldName} supports at most ${String(WEI_DECIMALS)} decimal places.` },
    );
  }

  const paddedFraction = fraction.padEnd(WEI_DECIMALS, '0');
  return BigInt(whole) * WEI_PER_ETHER + BigInt(paddedFraction);
}

/**
 * Renders wei as a decimal ETH string for humans. Display only; never feed the
 * result back into a calculation.
 */
export function formatWeiAsEther(wei: bigint): string {
  assertNonNegativeWei(wei, 'value');
  const whole = wei / WEI_PER_ETHER;
  const fraction = wei % WEI_PER_ETHER;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fractionText = fraction.toString().padStart(WEI_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

export function assertNonNegativeWei(value: bigint, fieldName: string): void {
  if (value < 0n) {
    throw new ChainBankError('INVALID_AMOUNT', `${fieldName} must not be negative`, {
      publicMessage: `${fieldName} must not be negative.`,
    });
  }
  if (value > MAX_NUMERIC_78) {
    throw new ChainBankError('INVALID_AMOUNT', `${fieldName} exceeds the supported numeric(78,0) range`, {
      publicMessage: `${fieldName} is too large to store.`,
    });
  }
}

/**
 * Parses a decimal-string wei quantity at an API/config boundary.
 *
 * JSON cannot represent wei exactly as a number; clients send decimal strings
 * of non-negative integers, which become `bigint` once here.
 */
export function parseWeiDecimalString(value: string, fieldName: string): bigint {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new ChainBankError(
      'INVALID_AMOUNT',
      `${fieldName} must be a non-negative decimal wei string, received "${trimmed}"`,
      { publicMessage: `${fieldName} must be a non-negative integer wei amount.` },
    );
  }
  const parsed = BigInt(trimmed);
  assertNonNegativeWei(parsed, fieldName);
  return parsed;
}

/**
 * Converts a `numeric(78,0)` column value, which the driver returns as a
 * string, into a bigint. Rejects anything non-integral rather than truncating.
 */
export function weiFromDatabaseNumeric(value: string, fieldName: string): bigint {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new ChainBankError(
      'INTERNAL_ERROR',
      `${fieldName} read from the database was not a non-negative integer: "${trimmed}"`,
    );
  }
  const parsed = BigInt(trimmed);
  assertNonNegativeWei(parsed, fieldName);
  return parsed;
}

/** Converts a bigint into the decimal string form the numeric(78,0) columns accept. */
export function weiToDatabaseNumeric(value: bigint, fieldName: string): string {
  assertNonNegativeWei(value, fieldName);
  return value.toString();
}
