import { ChainBankError } from '../errors.js';

/**
 * Next treasury account nonce for a signing attempt.
 *
 * RPC `pending` counts include mempool transactions the connected node has
 * seen. Durable in-flight rows (TX.10 broadcast intents and submitted transfers)
 * reserve a nonce even when that node still reports the pre-submit count
 * (`latest`, or `pending` before propagation). Taking the max closes the
 * cross-wallet reuse window after the advisory lock releases.
 */
export function allocateTreasuryNonce(input: {
  readonly rpcPendingCount: number;
  readonly maxInFlightNonce: number | undefined;
}): number {
  if (!Number.isInteger(input.rpcPendingCount) || input.rpcPendingCount < 0) {
    throw new ChainBankError('INVALID_REQUEST', 'rpcPendingCount must be a non-negative integer', {
      publicMessage: 'The request was not valid.',
    });
  }
  if (input.maxInFlightNonce === undefined) {
    return input.rpcPendingCount;
  }
  if (!Number.isInteger(input.maxInFlightNonce) || input.maxInFlightNonce < 0) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      'maxInFlightNonce must be a non-negative integer when present',
      { publicMessage: 'The request was not valid.' },
    );
  }
  return Math.max(input.rpcPendingCount, input.maxInFlightNonce + 1);
}
