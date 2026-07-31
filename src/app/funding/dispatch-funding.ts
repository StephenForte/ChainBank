import {
  calculateTopUp,
  calculateTreasurySpendableWei,
  type FundingPolicy,
} from '../../domain/funding/funding-math.js';
import { ChainBankError, describeUnknownError, isChainBankError } from '../../domain/errors.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { Logger } from '../../observability/logger.js';
import type {
  FundingDispatchLock,
  FundingOperation,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  ManagedWallet,
  ManagedWalletRepository,
  TreasurySigner,
} from '../ports.js';
import { ensureIdempotentOperation } from './ensure-idempotent-operation.js';

export interface DispatchFundingDependencies {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly managedWallets: ManagedWalletRepository;
  readonly lock: FundingDispatchLock;
  readonly signer: TreasurySigner;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly isFundingEnabled: boolean;
  readonly isFundingKillSwitchActive: boolean;
}

/**
 * Dispatch input never carries a destination address. The allowlisted address
 * is resolved solely from {@link ManagedWalletRepository.findById} (AGENTS.md §7.1).
 */
export interface DispatchFundingInput {
  readonly operationType: string;
  readonly projectId: string | undefined;
  readonly environmentId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly requestedBy: string;
  readonly correlationId: string;
  readonly treasury: {
    readonly id: string;
    readonly evmChainId: number;
    readonly enabled: boolean;
    readonly reserveWei: bigint;
    readonly balanceWei: bigint;
  };
  /** Managed wallet id only — destination address must come from the repository. */
  readonly walletId: string;
  readonly projectEnabled: boolean;
  readonly environmentEnabled: boolean;
  readonly policy: FundingPolicy;
  readonly walletBalanceWei: bigint;
}

export type DispatchFundingResult =
  | {
      readonly kind: 'replay';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction | undefined;
    }
  | {
      readonly kind: 'no-op';
      readonly operation: FundingOperation;
      readonly reason: 'at-or-above-minimum';
    }
  | {
      readonly kind: 'blocked';
      readonly operation: FundingOperation;
      readonly reason: 'reserve' | 'policy-disabled' | 'max-top-up-zero';
    }
  | {
      readonly kind: 'submitted';
      readonly operation: FundingOperation;
      readonly transaction: FundingTransaction;
    };

/**
 * Internal lock outcome. Business failures return here (so the DB transaction
 * commits status updates) and are rethrown after the lock releases.
 */
type LockOutcome = DispatchFundingResult | { readonly kind: 'throw'; readonly error: ChainBankError };

/**
 * The only application path that submits a treasury funding transaction.
 *
 * Security order of operations:
 * 1. Honor kill switch and enable flags (fail closed).
 * 2. Commit an idempotent funding_operations row before any RPC submission.
 * 3. Under pg_advisory_xact_lock(treasury, chain): re-verify chain ID, re-run
 *    reserve/policy math, refuse if a pending tx exists for the wallet, fetch
 *    nonce, submit, and persist the transaction hash before releasing the lock.
 *
 * Database unavailability prevents signing entirely — the lock/UoW acquisition
 * fails before `sendNativeTransfer` is called.
 *
 * Status writes for expected failures must commit with the lock transaction;
 * throwing inside the lock would roll them back.
 */
export async function dispatchFunding(
  dependencies: DispatchFundingDependencies,
  input: DispatchFundingInput,
): Promise<DispatchFundingResult> {
  // Resolve destination from the DB before any gate or RPC work so a caller
  // cannot influence the signed `to` address (AGENTS.md §7.1).
  const wallet = await resolveAllowlistedWallet(dependencies, input);
  assertFundingGates(dependencies, input, wallet);

  const ensured = await ensureIdempotentOperation(
    {
      operations: dependencies.operations,
      clock: dependencies.clock,
      idGenerator: dependencies.idGenerator,
    },
    {
      operationType: input.operationType,
      projectId: input.projectId,
      environmentId: input.environmentId,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy,
    },
  );

  if (ensured.kind === 'replay') {
    const transaction = await dependencies.transactions.findByOperationId(ensured.operation.id);
    dependencies.logger.info(
      {
        correlationId: input.correlationId,
        operationId: ensured.operation.id,
        status: ensured.operation.status,
      },
      'Funding dispatch idempotency replay',
    );
    return { kind: 'replay', operation: ensured.operation, transaction };
  }

  const operation = ensured.operation;

  let outcome: LockOutcome;
  try {
    outcome = await dependencies.lock.runExclusive(
      input.treasury.id,
      input.treasury.evmChainId,
      async (uow) => dispatchUnderLock(dependencies, input, operation, uow),
    );
  } catch (error) {
    if (!(isChainBankError(error) && error.code === 'DATABASE_UNAVAILABLE')) {
      dependencies.logger.error(
        {
          correlationId: input.correlationId,
          operationId: operation.id,
          detail: describeUnknownError(error),
        },
        'Funding dispatch failed',
      );
    }
    throw error;
  }

  if (outcome.kind === 'throw') {
    throw outcome.error;
  }
  return outcome;
}

async function dispatchUnderLock(
  dependencies: DispatchFundingDependencies,
  input: DispatchFundingInput,
  operation: FundingOperation,
  uow: {
    readonly operations: FundingOperationRepository;
    readonly transactions: FundingTransactionRepository;
  },
): Promise<LockOutcome> {
  // Re-resolve and re-check gates inside the lock so a flip mid-flight (disable,
  // address change) cannot race a send with a stale destination.
  const lockedWallet = await resolveAllowlistedWallet(dependencies, input);
  assertFundingGates(dependencies, input, lockedWallet);

  await uow.operations.markInProgress(operation.id);

  const pending = await uow.transactions.findPendingByManagedWallet(lockedWallet.id);
  if (pending !== undefined) {
    const completedAt = dependencies.clock.now();
    const failed = await uow.operations.markFailed(
      operation.id,
      'PENDING_FUNDING_EXISTS',
      'A funding transaction for this wallet is already in progress.',
      completedAt,
    );
    return {
      kind: 'throw',
      error: new ChainBankError(
        'PENDING_FUNDING_EXISTS',
        `Managed wallet ${lockedWallet.id} already has pending funding transaction ${pending.id}`,
        {
          publicMessage: 'A funding transfer for this wallet is already in progress.',
          context: {
            managedWalletId: lockedWallet.id,
            pendingTransactionId: pending.id,
            operationId: failed.id,
          },
        },
      ),
    };
  }

  const chainCheck = await dependencies.signer.verifyChainId();
  if (!chainCheck.matches) {
    const completedAt = dependencies.clock.now();
    await uow.operations.markFailed(
      operation.id,
      'SIGNER_CHAIN_MISMATCH',
      'RPC chain ID does not match configuration.',
      completedAt,
    );
    return {
      kind: 'throw',
      error: new ChainBankError(
        'SIGNER_CHAIN_MISMATCH',
        chainCheck.observedChainId === undefined
          ? `Unable to verify RPC chain ID before signing; configured chain is ${String(input.treasury.evmChainId)}.`
          : `RPC endpoint reports chain ${String(chainCheck.observedChainId)}, expected ${String(input.treasury.evmChainId)}. Refusing to sign.`,
        {
          publicMessage: 'Treasury signing refused because the RPC chain ID does not match configuration.',
          context: {
            configuredChainId: input.treasury.evmChainId,
            observedChainId: chainCheck.observedChainId ?? null,
            operationId: operation.id,
          },
        },
      ),
    };
  }

  // Destination is the checksummed display form from the registered row only.
  const destinationAddress = lockedWallet.addressDisplay;

  // Provisional amount for gas estimation: deficit capped by max top-up.
  const provisionalAmountWei = provisionalTopUpAmountWei(input);
  const estimatedCostWei = await dependencies.signer.estimateTransferCostWei(
    destinationAddress,
    provisionalAmountWei,
  );
  // Amounts already committed to unmined transfers from this treasury. The
  // observed balance cannot see them, so without this the reserve check would
  // pass repeatedly against the same pre-send balance (AGENTS.md §7.4).
  const inFlightWei = await uow.transactions.sumInFlightAmountWeiByTreasury(input.treasury.id);
  const treasurySpendableWei = calculateTreasurySpendableWei({
    treasuryBalanceWei: input.treasury.balanceWei,
    reserveWei: input.treasury.reserveWei,
    estimatedCostWei,
    inFlightWei,
  });
  const decision = calculateTopUp({
    currentBalanceWei: input.walletBalanceWei,
    policy: input.policy,
    treasurySpendableWei,
  });

  if (decision.kind === 'no-op') {
    const completedAt = dependencies.clock.now();
    const succeeded = await uow.operations.markSucceeded(operation.id, completedAt);
    return { kind: 'no-op', operation: succeeded, reason: decision.reason };
  }

  if (decision.kind === 'blocked') {
    const completedAt = dependencies.clock.now();
    const errorCode = decision.reason === 'reserve' ? 'FUNDING_BLOCKED_RESERVE' : 'FUNDING_DISABLED';
    const failed = await uow.operations.markFailed(
      operation.id,
      errorCode,
      `Funding blocked: ${decision.reason}`,
      completedAt,
    );
    return { kind: 'blocked', operation: failed, reason: decision.reason };
  }

  const createdAt = dependencies.clock.now();
  const created = await uow.transactions.insertCreated({
    id: dependencies.idGenerator.next(),
    operationId: operation.id,
    treasuryId: input.treasury.id,
    managedWalletId: lockedWallet.id,
    amountWei: decision.amountWei,
    createdAt,
  });

  // Nonce is obtained inside the advisory lock so concurrent dispatchers
  // cannot allocate the same nonce for this treasury.
  const nonce = await dependencies.signer.getTransactionCount();

  let transactionHash: string;
  try {
    const submitted = await dependencies.signer.sendNativeTransfer({
      to: destinationAddress,
      valueWei: decision.amountWei,
      nonce,
    });
    transactionHash = submitted.transactionHash;
  } catch (error) {
    const completedAt = dependencies.clock.now();
    const errorCode = isChainBankError(error) ? error.code : 'RPC_UNAVAILABLE';

    if (isProvablyBeforeBroadcast(errorCode)) {
      // The node rejected the request before it could enter the mempool, so no
      // transfer exists and the row is safely terminal.
      await uow.transactions.markFailed(created.id, errorCode);
      await uow.operations.markFailed(
        operation.id,
        errorCode,
        'Native transfer submission failed.',
        completedAt,
      );
    } else {
      // Ambiguous: a timeout or transport failure can follow a successful
      // broadcast. Record a non-terminal state so the wallet's duplicate gate
      // stays closed and reconciliation can resolve the real outcome.
      await uow.transactions.markSubmissionUnknown(created.id, { nonce, errorCode });
      dependencies.logger.error(
        {
          correlationId: input.correlationId,
          operationId: operation.id,
          transactionId: created.id,
          managedWalletId: lockedWallet.id,
          nonce,
          errorCode,
        },
        'Funding transaction submission outcome unknown; may be in flight',
      );
    }

    return {
      kind: 'throw',
      error: isChainBankError(error)
        ? error
        : new ChainBankError('RPC_UNAVAILABLE', 'Native transfer submission failed.', {
            publicMessage: 'The transfer could not be submitted.',
            cause: error,
          }),
    };
  }

  const submittedAt = dependencies.clock.now();
  const transaction = await uow.transactions.markSubmitted(created.id, {
    transactionHash,
    nonce,
    submittedAt,
  });

  // Operation stays in_progress until receipt tracking confirms an outcome.
  // Submission success is never treated as confirmation.
  dependencies.logger.info(
    {
      correlationId: input.correlationId,
      operationId: operation.id,
      transactionId: transaction.id,
      managedWalletId: lockedWallet.id,
      amountWei: decision.amountWei.toString(),
      nonce,
      transactionHash,
    },
    'Funding transaction submitted',
  );

  const refreshedOperation = await uow.operations.findById(operation.id);
  if (refreshedOperation === undefined) {
    return {
      kind: 'throw',
      error: new ChainBankError(
        'FUNDING_OPERATION_NOT_FOUND',
        `Funding operation ${operation.id} disappeared after submit`,
      ),
    };
  }

  return { kind: 'submitted', operation: refreshedOperation, transaction };
}

/**
 * Loads the registered managed wallet and verifies it belongs on the treasury's
 * chain. Destination allowlisting lives here — never accept an address from input.
 */
async function resolveAllowlistedWallet(
  dependencies: DispatchFundingDependencies,
  input: DispatchFundingInput,
): Promise<ManagedWallet> {
  const wallet = await dependencies.managedWallets.findById(input.walletId);
  if (wallet === undefined) {
    throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${input.walletId} does not exist`, {
      publicMessage: 'The managed wallet was not found.',
      context: { managedWalletId: input.walletId },
    });
  }
  if (wallet.chain.chainId !== input.treasury.evmChainId) {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Managed wallet ${wallet.id} is on chain ${String(wallet.chain.chainId)}, treasury expects ${String(input.treasury.evmChainId)}`,
      {
        publicMessage: 'The managed wallet is not registered on the treasury chain.',
        context: {
          managedWalletId: wallet.id,
          walletChainId: wallet.chain.chainId,
          treasuryChainId: input.treasury.evmChainId,
        },
      },
    );
  }
  return wallet;
}

function assertFundingGates(
  dependencies: DispatchFundingDependencies,
  input: DispatchFundingInput,
  wallet: ManagedWallet,
): void {
  if (!dependencies.isFundingEnabled) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_ENABLED is false; refusing to dispatch.', {
      publicMessage: 'Funding is disabled.',
    });
  }
  if (dependencies.isFundingKillSwitchActive) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_KILL_SWITCH is active; refusing to dispatch.', {
      publicMessage: 'Funding is temporarily disabled.',
    });
  }
  if (!input.treasury.enabled) {
    throw new ChainBankError('ENTITY_DISABLED', 'Treasury is disabled; refusing to dispatch.', {
      publicMessage: 'The treasury is disabled.',
      context: { treasuryId: input.treasury.id },
    });
  }
  if (!input.projectEnabled) {
    throw new ChainBankError('ENTITY_DISABLED', 'Project is disabled; refusing to dispatch.', {
      publicMessage: 'The project is disabled.',
      context: { projectId: input.projectId ?? null },
    });
  }
  if (!input.environmentEnabled) {
    throw new ChainBankError('ENTITY_DISABLED', 'Environment is disabled; refusing to dispatch.', {
      publicMessage: 'The environment is disabled.',
      context: { environmentId: input.environmentId ?? null },
    });
  }
  if (!wallet.enabled) {
    throw new ChainBankError('ENTITY_DISABLED', 'Managed wallet is disabled; refusing to dispatch.', {
      publicMessage: 'The managed wallet is disabled.',
      context: { managedWalletId: wallet.id },
    });
  }
}

/**
 * Error codes raised by validation performed before the signed transaction can
 * reach the network. Only these justify a terminal `failed` transaction row;
 * anything else (timeout, transport failure, unknown) must be treated as
 * possibly-broadcast. Fails closed: unrecognized codes are treated as ambiguous.
 */
const PRE_BROADCAST_ERROR_CODES: ReadonlySet<string> = new Set([
  'SIGNER_UNAVAILABLE',
  'SIGNER_CHAIN_MISMATCH',
  'CHAIN_ID_MISMATCH',
  'GAS_ESTIMATION_FAILED',
  'INVALID_AMOUNT',
  'INVALID_ADDRESS',
  'INVALID_REQUEST',
  'FUNDING_DISABLED',
  'ENTITY_DISABLED',
]);

function isProvablyBeforeBroadcast(errorCode: string): boolean {
  return PRE_BROADCAST_ERROR_CODES.has(errorCode);
}

/**
 * Deficit toward target, clamped by maximumTopUp. Used for gas estimation and
 * for the reserve-exhaustion email's `requestedAmountWei` (P1-US5 / T1.8) when
 * `calculateTopUp` returns `{ kind: 'blocked' }` without an amount.
 */
export function provisionalTopUpAmountWei(input: {
  readonly walletBalanceWei: bigint;
  readonly policy: FundingPolicy;
}): bigint {
  if (input.walletBalanceWei >= input.policy.minimumBalanceWei) {
    return 0n;
  }
  const deficit = input.policy.targetBalanceWei - input.walletBalanceWei;
  return deficit < input.policy.maximumTopUpWei ? deficit : input.policy.maximumTopUpWei;
}
