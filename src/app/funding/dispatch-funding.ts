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
  TreasurySigner,
} from '../ports.js';
import { ensureIdempotentOperation } from './ensure-idempotent-operation.js';

export interface DispatchFundingDependencies {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly lock: FundingDispatchLock;
  readonly signer: TreasurySigner;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly isFundingEnabled: boolean;
  readonly isFundingKillSwitchActive: boolean;
}

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
  readonly wallet: {
    readonly id: string;
    /** Checksummed, allowlisted destination — never an arbitrary caller address. */
    readonly address: string;
    readonly enabled: boolean;
  };
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
  assertFundingGates(dependencies, input);

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
  // Re-check gates inside the lock so a flip mid-flight cannot race a send.
  assertFundingGates(dependencies, input);

  await uow.operations.markInProgress(operation.id);

  const pending = await uow.transactions.findPendingByManagedWallet(input.wallet.id);
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
        `Managed wallet ${input.wallet.id} already has pending funding transaction ${pending.id}`,
        {
          publicMessage: 'A funding transfer for this wallet is already in progress.',
          context: {
            managedWalletId: input.wallet.id,
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

  // Provisional amount for gas estimation: deficit capped by max top-up.
  const provisionalAmountWei = provisionalTopUpAmountWei(input);
  const estimatedCostWei = await dependencies.signer.estimateTransferCostWei(
    input.wallet.address,
    provisionalAmountWei,
  );
  const treasurySpendableWei = calculateTreasurySpendableWei({
    treasuryBalanceWei: input.treasury.balanceWei,
    reserveWei: input.treasury.reserveWei,
    estimatedCostWei,
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
    managedWalletId: input.wallet.id,
    amountWei: decision.amountWei,
    createdAt,
  });

  // Nonce is obtained inside the advisory lock so concurrent dispatchers
  // cannot allocate the same nonce for this treasury.
  const nonce = await dependencies.signer.getTransactionCount();

  let transactionHash: string;
  try {
    const submitted = await dependencies.signer.sendNativeTransfer({
      to: input.wallet.address,
      valueWei: decision.amountWei,
      nonce,
    });
    transactionHash = submitted.transactionHash;
  } catch (error) {
    const completedAt = dependencies.clock.now();
    const errorCode = isChainBankError(error) ? error.code : 'RPC_UNAVAILABLE';
    await uow.transactions.markFailed(created.id, errorCode);
    await uow.operations.markFailed(
      operation.id,
      errorCode,
      'Native transfer submission failed.',
      completedAt,
    );
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
      managedWalletId: input.wallet.id,
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

function assertFundingGates(dependencies: DispatchFundingDependencies, input: DispatchFundingInput): void {
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
  if (!input.wallet.enabled) {
    throw new ChainBankError('ENTITY_DISABLED', 'Managed wallet is disabled; refusing to dispatch.', {
      publicMessage: 'The managed wallet is disabled.',
      context: { managedWalletId: input.wallet.id },
    });
  }
}

function provisionalTopUpAmountWei(input: DispatchFundingInput): bigint {
  if (input.walletBalanceWei >= input.policy.minimumBalanceWei) {
    return 0n;
  }
  const deficit = input.policy.targetBalanceWei - input.walletBalanceWei;
  return deficit < input.policy.maximumTopUpWei ? deficit : input.policy.maximumTopUpWei;
}
