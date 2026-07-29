import { ChainBankError, type ErrorCode } from '../errors.js';
import { assertNonNegativeWei } from '../wei.js';

/**
 * Validated funding policy used by top-up math.
 *
 * `isEnabled` is supplied by the application layer (wallet/project/environment
 * gates). Amount fields must satisfy `validatePolicy` before use.
 */
export interface FundingPolicy {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly isEnabled: boolean;
}

/** Untrusted policy input; amounts are checked by `validatePolicy`. */
export interface FundingPolicyInput {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly isEnabled: boolean;
}

export type TopUpDecision =
  | { readonly kind: 'no-op'; readonly reason: 'at-or-above-minimum' }
  | { readonly kind: 'fund'; readonly amountWei: bigint }
  | {
      readonly kind: 'blocked';
      readonly reason: 'reserve' | 'max-top-up-zero' | 'policy-disabled';
    };

export type PolicyValidationResult =
  | { readonly ok: true; readonly policy: FundingPolicy }
  | {
      readonly ok: false;
      readonly code: Extract<ErrorCode, 'INVALID_AMOUNT' | 'INVALID_CONFIGURATION'>;
      readonly message: string;
      readonly publicMessage: string;
    };

/**
 * Spendable treasury balance after reserve, conservative transfer cost, and
 * amounts already committed to in-flight transfers. Floors at zero.
 *
 * `inFlightWei` is required because an observed on-chain balance cannot see this
 * treasury's own submitted-but-unmined transfers: `eth_getBalance` only reflects
 * mined state. Without it, funding several wallets inside one block window each
 * measures against the same pre-send balance and collectively breaches the
 * reserve (PRD §8.5, AGENTS.md §7.4).
 */
export function calculateTreasurySpendableWei(input: {
  readonly treasuryBalanceWei: bigint;
  readonly reserveWei: bigint;
  readonly estimatedCostWei: bigint;
  readonly inFlightWei: bigint;
}): bigint {
  assertNonNegativeWei(input.treasuryBalanceWei, 'treasuryBalanceWei');
  assertNonNegativeWei(input.reserveWei, 'reserveWei');
  assertNonNegativeWei(input.estimatedCostWei, 'estimatedCostWei');
  assertNonNegativeWei(input.inFlightWei, 'inFlightWei');

  const spendable = input.treasuryBalanceWei - input.reserveWei - input.estimatedCostWei - input.inFlightWei;
  return spendable > 0n ? spendable : 0n;
}

/**
 * Validates funding policy invariants (PRD P1-US2):
 * non-negative integers, target >= minimum, maximumTopUp > 0.
 */
export function validatePolicy(input: FundingPolicyInput): PolicyValidationResult {
  const amountCheck = validateNonNegativeAmounts(input);
  if (amountCheck !== undefined) {
    return amountCheck;
  }

  if (input.targetBalanceWei < input.minimumBalanceWei) {
    return {
      ok: false,
      code: 'INVALID_CONFIGURATION',
      message: 'targetBalanceWei must be greater than or equal to minimumBalanceWei',
      publicMessage: 'Target balance must be at least the minimum balance.',
    };
  }

  if (input.maximumTopUpWei === 0n) {
    return {
      ok: false,
      code: 'INVALID_CONFIGURATION',
      message: 'maximumTopUpWei must be greater than zero',
      publicMessage: 'Maximum top-up must be positive.',
    };
  }

  return {
    ok: true,
    policy: {
      minimumBalanceWei: input.minimumBalanceWei,
      targetBalanceWei: input.targetBalanceWei,
      maximumTopUpWei: input.maximumTopUpWei,
      isEnabled: input.isEnabled,
    },
  };
}

/**
 * Pure top-up decision (PRD §8.2, §8.5).
 *
 * Fund only when below minimum; restore toward target; clamp by maximum top-up
 * then by treasury spendable. Never invent a transfer when spendable is zero.
 */
export function calculateTopUp(input: {
  readonly currentBalanceWei: bigint;
  readonly policy: FundingPolicy;
  readonly treasurySpendableWei: bigint;
}): TopUpDecision {
  assertNonNegativeWei(input.currentBalanceWei, 'currentBalanceWei');
  assertNonNegativeWei(input.treasurySpendableWei, 'treasurySpendableWei');
  assertNonNegativeWei(input.policy.minimumBalanceWei, 'minimumBalanceWei');
  assertNonNegativeWei(input.policy.targetBalanceWei, 'targetBalanceWei');
  assertNonNegativeWei(input.policy.maximumTopUpWei, 'maximumTopUpWei');

  // Hysteresis (PRD §8.2): at or above minimum never transfers, even if disabled.
  if (input.currentBalanceWei >= input.policy.minimumBalanceWei) {
    return { kind: 'no-op', reason: 'at-or-above-minimum' };
  }

  if (!input.policy.isEnabled) {
    return { kind: 'blocked', reason: 'policy-disabled' };
  }

  if (input.policy.maximumTopUpWei === 0n) {
    return { kind: 'blocked', reason: 'max-top-up-zero' };
  }

  if (input.policy.targetBalanceWei < input.policy.minimumBalanceWei) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'targetBalanceWei must be greater than or equal to minimumBalanceWei',
      { publicMessage: 'Target balance must be at least the minimum balance.' },
    );
  }

  // Below minimum with a valid policy implies target > current, so deficit > 0.
  const deficitWei = input.policy.targetBalanceWei - input.currentBalanceWei;
  let amountWei = deficitWei < input.policy.maximumTopUpWei ? deficitWei : input.policy.maximumTopUpWei;
  amountWei = amountWei < input.treasurySpendableWei ? amountWei : input.treasurySpendableWei;

  if (amountWei === 0n) {
    return { kind: 'blocked', reason: 'reserve' };
  }

  return { kind: 'fund', amountWei };
}

function validateNonNegativeAmounts(
  input: FundingPolicyInput,
): Extract<PolicyValidationResult, { ok: false }> | undefined {
  const fields: ReadonlyArray<{ readonly name: string; readonly value: bigint }> = [
    { name: 'minimumBalanceWei', value: input.minimumBalanceWei },
    { name: 'targetBalanceWei', value: input.targetBalanceWei },
    { name: 'maximumTopUpWei', value: input.maximumTopUpWei },
  ];

  for (const field of fields) {
    if (field.value < 0n) {
      return {
        ok: false,
        code: 'INVALID_AMOUNT',
        message: `${field.name} must not be negative`,
        publicMessage: `${field.name} must not be negative.`,
      };
    }
  }

  return undefined;
}
