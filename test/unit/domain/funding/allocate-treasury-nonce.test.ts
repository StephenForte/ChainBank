import { describe, expect, it } from 'vitest';
import { allocateTreasuryNonce } from '../../../../src/domain/funding/allocate-treasury-nonce.js';

describe('allocateTreasuryNonce', () => {
  it('uses the RPC pending count when no in-flight nonce is reserved', () => {
    expect(allocateTreasuryNonce({ rpcPendingCount: 7, maxInFlightNonce: undefined })).toBe(7);
  });

  it('advances past a durable in-flight nonce when RPC still reports the prior count', () => {
    // Cross-wallet race after lock release: wallet A reserved nonce 7; wallet B
    // still sees pending/latest 7 from a lagging node.
    expect(allocateTreasuryNonce({ rpcPendingCount: 7, maxInFlightNonce: 7 })).toBe(8);
  });

  it('keeps the higher RPC pending count when the mempool already advanced', () => {
    expect(allocateTreasuryNonce({ rpcPendingCount: 9, maxInFlightNonce: 7 })).toBe(9);
  });

  it('rejects non-integer or negative inputs', () => {
    expect(() => allocateTreasuryNonce({ rpcPendingCount: -1, maxInFlightNonce: undefined })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() => allocateTreasuryNonce({ rpcPendingCount: 1.5, maxInFlightNonce: undefined })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() => allocateTreasuryNonce({ rpcPendingCount: 0, maxInFlightNonce: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });
});
