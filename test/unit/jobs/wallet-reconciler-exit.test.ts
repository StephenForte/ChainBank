import { describe, expect, it } from 'vitest';
import { classifyReconcilerExit, reconcilerExitCode } from '../../../src/jobs/wallet-reconciler.js';

describe('wallet reconciler exit semantics', () => {
  it('treats a clean run as success (exit 0)', () => {
    expect(classifyReconcilerExit(undefined)).toBe('success');
    expect(reconcilerExitCode('success')).toBe(0);
  });

  it('treats FUNDING_DISABLED / kill switch as policy (exit 0)', () => {
    expect(classifyReconcilerExit('FUNDING_DISABLED')).toBe('policy-disabled');
    expect(reconcilerExitCode('policy-disabled')).toBe(0);
  });

  it('treats run-level malfunctions as non-zero', () => {
    for (const code of [
      'DATABASE_UNAVAILABLE',
      'RPC_UNAVAILABLE',
      'SIGNER_UNAVAILABLE',
      'INTERNAL_ERROR',
      'INVALID_CONFIGURATION',
    ]) {
      expect(classifyReconcilerExit(code)).toBe('malfunction');
      expect(reconcilerExitCode(classifyReconcilerExit(code))).toBe(1);
    }
  });
});
