import type { ErrorCode } from './errors.js';

/**
 * The outcome of an on-chain balance read.
 *
 * This is a discriminated union rather than a nullable balance so that no
 * caller can accidentally coerce a failed read into `0n`. A treasury that
 * cannot be read is unknown, which is operationally very different from empty.
 */
export type BalanceReading =
  | {
      readonly kind: 'observed';
      readonly balanceWei: bigint;
      readonly blockNumber: bigint;
      readonly observedAt: Date;
    }
  | {
      readonly kind: 'unavailable';
      readonly errorCode: Extract<ErrorCode, 'RPC_UNAVAILABLE' | 'CHAIN_ID_MISMATCH'>;
      readonly reason: string;
      readonly observedAt: Date;
    };

export function isObservedBalance(
  reading: BalanceReading,
): reading is Extract<BalanceReading, { kind: 'observed' }> {
  return reading.kind === 'observed';
}
