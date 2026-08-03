import type {
  BalanceReader,
  ConfirmedNonceResult,
  FindByNonceResult,
  FundingDispatchLock,
  FundingDispatchUnitOfWork,
  FundingOperation,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionListPage,
  FundingTransactionRepository,
  InsertBroadcastIntentInput,
  InsertFundingOperationInput,
  InsertFundingTransactionInput,
  OutgoingScanResult,
  ReconciliationFundingQuery,
  ReconciliationRun,
  ReconciliationRunRepository,
  TransactionReceiptTracker,
  TransactionTrackingOutcome,
  TreasuryOutgoingScanner,
  TreasuryOutgoingTransfer,
  TreasurySigner,
} from '../../src/app/ports.js';
import type { BalanceReading } from '../../src/domain/balance-reading.js';
import { ChainBankError } from '../../src/domain/errors.js';
import {
  canTransitionOperationStatus,
  canTransitionTransactionStatus,
  isPendingTransactionStatus,
  type FundingOperationStatus,
  type FundingTransactionStatus,
} from '../../src/domain/funding/statuses.js';
import { isUniqueViolation } from '../../src/shared/postgres-error.js';

/** Simulates a Postgres unique-violation for idempotency race tests. */
export class UniqueViolationError extends Error {
  readonly code = '23505';
  constructor() {
    super('duplicate key value violates unique constraint');
    this.name = 'UniqueViolationError';
  }
}

export function createInMemoryFundingStores(): {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly lock: FundingDispatchLock;
  readonly opsById: Map<string, FundingOperation>;
  readonly txsById: Map<string, FundingTransaction>;
} {
  const opsById = new Map<string, FundingOperation>();
  const txsById = new Map<string, FundingTransaction>();

  const operations: FundingOperationRepository = {
    findById(id) {
      return Promise.resolve(opsById.get(id));
    },
    findByIdempotencyKey(requestedBy, idempotencyKey) {
      for (const op of opsById.values()) {
        if (op.requestedBy === requestedBy && op.idempotencyKey === idempotencyKey) {
          return Promise.resolve(op);
        }
      }
      return Promise.resolve(undefined);
    },
    insertPending(input: InsertFundingOperationInput) {
      if (input.idempotencyKey !== undefined) {
        for (const op of opsById.values()) {
          if (op.requestedBy === input.requestedBy && op.idempotencyKey === input.idempotencyKey) {
            return Promise.reject(new UniqueViolationError());
          }
        }
      }
      const operation: FundingOperation = {
        id: input.id,
        operationType: input.operationType,
        projectId: input.projectId,
        environmentId: input.environmentId,
        idempotencyKey: input.idempotencyKey,
        status: 'pending',
        requestedBy: input.requestedBy,
        startedAt: input.startedAt,
        completedAt: undefined,
        errorCode: undefined,
        errorSummary: undefined,
      };
      opsById.set(operation.id, operation);
      return Promise.resolve(operation);
    },
    markInProgress(id) {
      return Promise.resolve(transitionOp(opsById, id, 'in_progress', {}));
    },
    markSucceeded(id, completedAt) {
      return Promise.resolve(transitionOp(opsById, id, 'succeeded', { completedAt }));
    },
    markFailed(id, errorCode, errorSummary, completedAt) {
      return Promise.resolve(transitionOp(opsById, id, 'failed', { errorCode, errorSummary, completedAt }));
    },
    markAbandoned(id, errorCode, errorSummary, completedAt) {
      return Promise.resolve(
        transitionOp(opsById, id, 'abandoned', { errorCode, errorSummary, completedAt }),
      );
    },
  };

  const transactions: FundingTransactionRepository = {
    findById(id) {
      return Promise.resolve(txsById.get(id));
    },
    findByOperationId(operationId) {
      for (const tx of txsById.values()) {
        if (tx.operationId === operationId) {
          return Promise.resolve(tx);
        }
      }
      return Promise.resolve(undefined);
    },
    findPendingByManagedWallet(managedWalletId) {
      for (const tx of txsById.values()) {
        if (tx.managedWalletId === managedWalletId && isPendingTransactionStatus(tx.status)) {
          return Promise.resolve(tx);
        }
      }
      return Promise.resolve(undefined);
    },
    sumInFlightAmountWeiByTreasury(treasuryId) {
      let total = 0n;
      for (const tx of txsById.values()) {
        if (tx.treasuryId === treasuryId && isPendingTransactionStatus(tx.status)) {
          total += tx.amountWei;
        }
      }
      return Promise.resolve(total);
    },
    insertCreated(input: InsertFundingTransactionInput) {
      const tx: FundingTransaction = {
        id: input.id,
        operationId: input.operationId,
        treasuryId: input.treasuryId,
        managedWalletId: input.managedWalletId,
        amountWei: input.amountWei,
        transactionHash: undefined,
        nonce: undefined,
        status: 'created',
        errorCode: undefined,
        createdAt: input.createdAt,
        submittedAt: undefined,
        confirmedAt: undefined,
      };
      txsById.set(tx.id, tx);
      return Promise.resolve(tx);
    },
    insertBroadcastIntent(input: InsertBroadcastIntentInput) {
      const tx: FundingTransaction = {
        id: input.id,
        operationId: input.operationId,
        treasuryId: input.treasuryId,
        managedWalletId: input.managedWalletId,
        amountWei: input.amountWei,
        transactionHash: undefined,
        nonce: input.nonce,
        status: 'submission_unknown',
        errorCode: 'BROADCAST_INTENT',
        createdAt: input.createdAt,
        submittedAt: undefined,
        confirmedAt: undefined,
      };
      txsById.set(tx.id, tx);
      return Promise.resolve(tx);
    },
    markSubmitted(id, input) {
      return Promise.resolve(
        transitionTx(txsById, id, 'submitted', {
          transactionHash: input.transactionHash,
          nonce: input.nonce,
          submittedAt: input.submittedAt,
        }),
      );
    },
    markSubmissionUnknown(id, input) {
      return Promise.resolve(
        transitionTx(txsById, id, 'submission_unknown', {
          nonce: input.nonce,
          errorCode: input.errorCode,
        }),
      );
    },
    markConfirmed(id, confirmedAt) {
      return Promise.resolve(transitionTx(txsById, id, 'confirmed', { confirmedAt }));
    },
    markReverted(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'reverted', { errorCode }));
    },
    markReplaced(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'replaced', { errorCode }));
    },
    markDropped(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'dropped', { errorCode }));
    },
    markFailed(id, errorCode) {
      return Promise.resolve(transitionTx(txsById, id, 'failed', { errorCode }));
    },
    list() {
      return Promise.resolve({ items: [], total: 0 } satisfies FundingTransactionListPage);
    },
  };

  const lock: FundingDispatchLock = {
    runExclusive(_treasuryId, _evmChainId, work) {
      const uow: FundingDispatchUnitOfWork = { operations, transactions };
      return work(uow);
    },
  };

  return { operations, transactions, lock, opsById, txsById };
}

function transitionOp(
  store: Map<string, FundingOperation>,
  id: string,
  to: FundingOperationStatus,
  fields: {
    readonly completedAt?: Date;
    readonly errorCode?: string;
    readonly errorSummary?: string;
  },
): FundingOperation {
  const existing = store.get(id);
  if (existing === undefined) {
    throw new ChainBankError('FUNDING_OPERATION_NOT_FOUND', `missing ${id}`);
  }
  if (!canTransitionOperationStatus(existing.status, to)) {
    throw new ChainBankError('INVALID_STATUS_TRANSITION', `${existing.status} -> ${to}`);
  }
  const next: FundingOperation = {
    ...existing,
    status: to,
    completedAt: fields.completedAt ?? existing.completedAt,
    errorCode: fields.errorCode ?? existing.errorCode,
    errorSummary: fields.errorSummary ?? existing.errorSummary,
  };
  store.set(id, next);
  return next;
}

function transitionTx(
  store: Map<string, FundingTransaction>,
  id: string,
  to: FundingTransactionStatus,
  fields: {
    readonly transactionHash?: string;
    readonly nonce?: number;
    readonly submittedAt?: Date;
    readonly confirmedAt?: Date;
    readonly errorCode?: string;
  },
): FundingTransaction {
  const existing = store.get(id);
  if (existing === undefined) {
    throw new ChainBankError('FUNDING_TRANSACTION_NOT_FOUND', `missing ${id}`);
  }
  if (!canTransitionTransactionStatus(existing.status, to)) {
    throw new ChainBankError('INVALID_STATUS_TRANSITION', `${existing.status} -> ${to}`);
  }
  const next: FundingTransaction = {
    ...existing,
    status: to,
    transactionHash: fields.transactionHash ?? existing.transactionHash,
    nonce: fields.nonce ?? existing.nonce,
    submittedAt: fields.submittedAt ?? existing.submittedAt,
    confirmedAt: fields.confirmedAt ?? existing.confirmedAt,
    errorCode: fields.errorCode ?? existing.errorCode,
  };
  store.set(id, next);
  return next;
}

/**
 * Controllable BalanceReader for dispatch / ensure-funded tests.
 *
 * Balances are keyed by lowercase address and may be mutated after construction
 * (e.g. to simulate a confirmed top-up visible to a later in-lock re-read).
 */
export function createFakeBalanceReader(options?: {
  readonly balances?: Map<string, bigint> | Readonly<Record<string, bigint>>;
  readonly unavailable?: Readonly<
    Record<string, Extract<BalanceReading, { kind: 'unavailable' }>['errorCode']>
  >;
  readonly observedAt?: Date;
  readonly chainId?: number;
}): BalanceReader & {
  readonly reads: string[];
  readonly balances: Map<string, bigint>;
  setBalance(address: string, balanceWei: bigint): void;
  setUnavailable(
    address: string,
    errorCode: Extract<BalanceReading, { kind: 'unavailable' }>['errorCode'],
  ): void;
} {
  const balances = new Map<string, bigint>();
  if (options?.balances instanceof Map) {
    for (const [address, balanceWei] of options.balances) {
      balances.set(address.toLowerCase(), balanceWei);
    }
  } else if (options?.balances !== undefined) {
    for (const [address, balanceWei] of Object.entries(options.balances)) {
      balances.set(address.toLowerCase(), balanceWei);
    }
  }
  const unavailable = new Map<string, Extract<BalanceReading, { kind: 'unavailable' }>['errorCode']>();
  if (options?.unavailable !== undefined) {
    for (const [address, errorCode] of Object.entries(options.unavailable)) {
      unavailable.set(address.toLowerCase(), errorCode);
    }
  }
  const reads: string[] = [];
  const observedAt = options?.observedAt ?? new Date('2026-07-29T12:00:00.000Z');
  const chainId = options?.chainId ?? 11_155_111;

  return {
    reads,
    balances,
    setBalance(address, balanceWei) {
      balances.set(address.toLowerCase(), balanceWei);
      unavailable.delete(address.toLowerCase());
    },
    setUnavailable(address, errorCode) {
      unavailable.set(address.toLowerCase(), errorCode);
    },
    readBalance(address) {
      const normalized = address.toLowerCase();
      reads.push(normalized);
      const errorCode = unavailable.get(normalized);
      if (errorCode !== undefined) {
        return Promise.resolve({
          kind: 'unavailable',
          errorCode,
          reason: `Simulated ${errorCode} for ${normalized}`,
          observedAt,
        });
      }
      return Promise.resolve({
        kind: 'observed',
        balanceWei: balances.get(normalized) ?? 0n,
        blockNumber: 42n,
        observedAt,
      });
    },
    verifyChainId() {
      return Promise.resolve({ matches: true, observedChainId: chainId });
    },
  };
}

/**
 * Controllable treasury signer for unit/integration tests.
 *
 * When `rejectReusedNonce` is true, a nonce that has already been used throws a
 * NONCE_CONFLICT-shaped error (duck-typed `{ code: 'NONCE_CONFLICT' }`) instead
 * of silently succeeding — recovering the node-level reuse rejection a mocked
 * chain otherwise loses (C16 / D6 final). Default remains false so every
 * existing caller is unaffected.
 */
export function createFakeSigner(overrides: {
  readonly send?: TreasurySigner['sendNativeTransfer'];
  readonly chainMatches?: boolean;
  readonly nonce?: number;
  readonly estimatedCostWei?: bigint;
  readonly address?: string;
  /** When true, reject a nonce that has already been used (C16). Default false. */
  readonly rejectReusedNonce?: boolean;
}): TreasurySigner & {
  readonly sendCalls: number;
  readonly nonces: number[];
  /** How many times send was refused for a reused nonce (C16). */
  readonly nonceConflictCount: number;
} {
  const state = { sendCalls: 0, nonces: [] as number[], nonceConflictCount: 0 };
  const usedNonces = new Set<number>();
  const signer: TreasurySigner & {
    readonly sendCalls: number;
    readonly nonces: number[];
    readonly nonceConflictCount: number;
  } = {
    get address() {
      return overrides.address ?? '0x1111111111111111111111111111111111111111';
    },
    get sendCalls() {
      return state.sendCalls;
    },
    get nonces() {
      return state.nonces;
    },
    get nonceConflictCount() {
      return state.nonceConflictCount;
    },
    verifyChainId() {
      return Promise.resolve({
        matches: overrides.chainMatches ?? true,
        observedChainId: overrides.chainMatches === false ? 1 : 11_155_111,
      });
    },
    getTransactionCount() {
      // With reuse rejection enabled, mirror a node: next nonce is the count of
      // successful sends (or the explicit override seed when provided).
      if (overrides.rejectReusedNonce === true && overrides.nonce === undefined) {
        return Promise.resolve(state.sendCalls);
      }
      return Promise.resolve(overrides.nonce ?? 7);
    },
    estimateTransferCostWei() {
      return Promise.resolve(overrides.estimatedCostWei ?? 21_000n);
    },
    sendNativeTransfer(input) {
      if (overrides.rejectReusedNonce === true && usedNonces.has(input.nonce)) {
        state.nonceConflictCount += 1;
        throw createNonceConflictError(input.nonce);
      }
      state.nonces.push(input.nonce);
      if (overrides.rejectReusedNonce === true) {
        usedNonces.add(input.nonce);
      }
      state.sendCalls += 1;
      if (overrides.send !== undefined) {
        return overrides.send(input);
      }
      return Promise.resolve({
        transactionHash: `0x${'ab'.repeat(32)}`,
      });
    },
  };
  return signer;
}

/** Duck-typed ChainBank NONCE_CONFLICT error for the nonce-rejecting signer fake (C16). */
export function createNonceConflictError(nonce: number): Error & { readonly code: 'NONCE_CONFLICT' } {
  const error = new Error(`Nonce ${String(nonce)} has already been used`) as Error & {
    code: 'NONCE_CONFLICT';
  };
  error.name = 'ChainBankError';
  error.code = 'NONCE_CONFLICT';
  return error;
}

export function createFakeReceiptTracker(
  outcome: TransactionTrackingOutcome | (() => TransactionTrackingOutcome),
): TransactionReceiptTracker {
  return {
    waitForOutcome() {
      return Promise.resolve(typeof outcome === 'function' ? outcome() : outcome);
    },
  };
}

/** Explicitly resolved promise gate for deterministic concurrency tests (no sleeps). */
export function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Signer whose `sendNativeTransfer` latency is controlled by caller-resolved
 * promises. Used by concurrency/crash-recovery integration tests so races are
 * exercised without `setTimeout` polling.
 */
export function createControllableSigner(options: {
  readonly address?: string;
  readonly estimatedCostWei?: bigint;
  readonly chainMatches?: boolean;
  /** Invoked before the call is counted; await a deferred here to hold the lock. */
  readonly onSend?: (input: {
    readonly to: string;
    readonly valueWei: bigint;
    readonly nonce: number;
  }) => Promise<void>;
  readonly getNonce?: () => number;
  /** When provided, throw this instead of returning a hash (after onSend). */
  readonly sendError?: () => unknown;
}): TreasurySigner & {
  readonly sendCalls: number;
  readonly nonces: number[];
  readonly enteredSendCount: number;
} {
  const state = { sendCalls: 0, nonces: [] as number[], enteredSendCount: 0 };
  return {
    get address() {
      return options.address ?? '0x1111111111111111111111111111111111111111';
    },
    get sendCalls() {
      return state.sendCalls;
    },
    get nonces() {
      return state.nonces;
    },
    get enteredSendCount() {
      return state.enteredSendCount;
    },
    verifyChainId() {
      return Promise.resolve({
        matches: options.chainMatches ?? true,
        observedChainId: options.chainMatches === false ? 1 : 11_155_111,
      });
    },
    getTransactionCount() {
      return Promise.resolve(options.getNonce?.() ?? state.sendCalls);
    },
    estimateTransferCostWei() {
      return Promise.resolve(options.estimatedCostWei ?? 21_000n);
    },
    async sendNativeTransfer(input) {
      state.enteredSendCount += 1;
      state.nonces.push(input.nonce);
      if (options.onSend !== undefined) {
        await options.onSend(input);
      }
      if (options.sendError !== undefined) {
        throw options.sendError();
      }
      state.sendCalls += 1;
      return { transactionHash: `0x${state.sendCalls.toString(16).padStart(64, '0')}` };
    },
  };
}

export { isUniqueViolation };

/** In-memory reconciliation run store for unit / integration fakes. */
export function createInMemoryReconciliationRunRepository(): ReconciliationRunRepository & {
  readonly runsById: Map<string, ReconciliationRun>;
} {
  const runsById = new Map<string, ReconciliationRun>();
  return {
    runsById,
    insertStarted(input) {
      const run: ReconciliationRun = {
        id: input.id,
        runId: input.runId,
        requestedBy: input.requestedBy,
        startedAt: input.startedAt,
        finishedAt: undefined,
        walletsAssessed: 0,
        walletsFunded: 0,
        walletsNoop: 0,
        walletsBlocked: 0,
        walletsFailed: 0,
        weiTransferred: 0n,
        submissionUnknownResolved: 0,
        submissionUnknownLeftPending: 0,
        unexplainedTransferCount: 0,
        outgoingScanStatus: 'not-run',
        findings: [],
        errorCode: undefined,
        errorSummary: undefined,
      };
      runsById.set(run.id, run);
      return Promise.resolve(run);
    },
    markFinished(input) {
      const existing = runsById.get(input.id);
      if (existing === undefined) {
        return Promise.reject(new ChainBankError('DATABASE_UNAVAILABLE', `missing run ${input.id}`));
      }
      const next: ReconciliationRun = {
        ...existing,
        finishedAt: input.finishedAt,
        walletsAssessed: input.walletsAssessed,
        walletsFunded: input.walletsFunded,
        walletsNoop: input.walletsNoop,
        walletsBlocked: input.walletsBlocked,
        walletsFailed: input.walletsFailed,
        weiTransferred: input.weiTransferred,
        submissionUnknownResolved: input.submissionUnknownResolved,
        submissionUnknownLeftPending: input.submissionUnknownLeftPending,
        unexplainedTransferCount: input.unexplainedTransferCount,
        outgoingScanStatus: input.outgoingScanStatus,
        findings: input.findings,
        errorCode: input.errorCode,
        errorSummary: input.errorSummary,
      };
      runsById.set(next.id, next);
      return Promise.resolve(next);
    },
    findById(id) {
      return Promise.resolve(runsById.get(id));
    },
    listRecent(limit) {
      const sorted = [...runsById.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return Promise.resolve(sorted.slice(0, limit));
    },
  };
}

/** Controllable outgoing scanner for reconciliation unit/integration tests. */
export function createFakeOutgoingScanner(options?: {
  readonly confirmedNonce?: number | (() => number);
  readonly latestBlockNumber?: bigint;
  readonly transfers?: readonly TreasuryOutgoingTransfer[];
  readonly findByNonce?: (nonce: number) => FindByNonceResult;
  readonly listResult?: OutgoingScanResult;
  readonly nonceResult?: ConfirmedNonceResult;
}): TreasuryOutgoingScanner & {
  setConfirmedNonce(nonce: number): void;
  setLatestBlockNumber(blockNumber: bigint): void;
  setTransfers(transfers: readonly TreasuryOutgoingTransfer[]): void;
  setListIncomplete(errorCode: string, reason: string): void;
  setCountAtBlockUnavailable(errorCode: string, reason: string): void;
  clearCountAtBlockUnavailable(): void;
  /** Tip + count-at-block + list calls — the scanner RPC budget under test. */
  scannerRpcCallCount(): number;
  readonly latestBlockCalls: Array<{ at: number }>;
  readonly countAtBlockCalls: Array<{ address: string; blockNumber: bigint }>;
  readonly listCalls: Array<{ fromAddress: string; fromBlock: bigint; toBlock: bigint }>;
  readonly findByNonceCalls: Array<{ fromAddress: string; nonce: number; lookbackBlocks: bigint }>;
} {
  let confirmedNonce =
    typeof options?.confirmedNonce === 'function' ? options.confirmedNonce() : (options?.confirmedNonce ?? 0);
  let latestBlockNumber = options?.latestBlockNumber ?? 1_000n;
  let transfers = [...(options?.transfers ?? [])];
  let listOverride: OutgoingScanResult | undefined = options?.listResult;
  let nonceOverride: ConfirmedNonceResult | undefined = options?.nonceResult;
  let countAtBlockOverride: ConfirmedNonceResult | undefined;
  /** When > 0, the override applies to the next N count-at-block calls only. */
  let countAtBlockOverrideRemaining = 0;
  const latestBlockCalls: Array<{ at: number }> = [];
  const countAtBlockCalls: Array<{ address: string; blockNumber: bigint }> = [];
  const listCalls: Array<{ fromAddress: string; fromBlock: bigint; toBlock: bigint }> = [];
  const findByNonceCalls: Array<{ fromAddress: string; nonce: number; lookbackBlocks: bigint }> = [];

  return {
    latestBlockCalls,
    countAtBlockCalls,
    listCalls,
    findByNonceCalls,
    scannerRpcCallCount() {
      // Tip + count-at-block + body list. findByNonce is a separate settlement path.
      return latestBlockCalls.length + countAtBlockCalls.length + listCalls.length;
    },
    setConfirmedNonce(nonce) {
      confirmedNonce = nonce;
      nonceOverride = undefined;
      countAtBlockOverride = undefined;
      countAtBlockOverrideRemaining = 0;
    },
    setLatestBlockNumber(blockNumber) {
      latestBlockNumber = blockNumber;
    },
    setTransfers(next) {
      transfers = [...next];
      listOverride = undefined;
    },
    setListIncomplete(errorCode, reason) {
      listOverride = { kind: 'incomplete', errorCode, reason };
    },
    setCountAtBlockUnavailable(errorCode, reason) {
      // One-shot by default: gate fails closed into a full scan; the post-scan
      // seed read can still succeed (transient RPC blip).
      countAtBlockOverride = { kind: 'unavailable', errorCode, reason };
      countAtBlockOverrideRemaining = 1;
    },
    clearCountAtBlockUnavailable() {
      countAtBlockOverride = undefined;
      countAtBlockOverrideRemaining = 0;
    },
    getConfirmedTransactionCount() {
      if (nonceOverride !== undefined) {
        return Promise.resolve(nonceOverride);
      }
      return Promise.resolve({ kind: 'ok' as const, confirmedNonce });
    },
    getLatestBlockNumber() {
      latestBlockCalls.push({ at: latestBlockCalls.length });
      return Promise.resolve({ kind: 'ok' as const, blockNumber: latestBlockNumber });
    },
    getTransactionCountAtBlock(input) {
      countAtBlockCalls.push({ address: input.address, blockNumber: input.blockNumber });
      if (countAtBlockOverride !== undefined && countAtBlockOverrideRemaining > 0) {
        countAtBlockOverrideRemaining -= 1;
        const result = countAtBlockOverride;
        if (countAtBlockOverrideRemaining === 0) {
          countAtBlockOverride = undefined;
        }
        return Promise.resolve(result);
      }
      if (nonceOverride !== undefined) {
        return Promise.resolve(nonceOverride);
      }
      return Promise.resolve({ kind: 'ok' as const, confirmedNonce });
    },
    findOutgoingByNonce(input) {
      findByNonceCalls.push({
        fromAddress: input.fromAddress,
        nonce: input.nonce,
        lookbackBlocks: input.lookbackBlocks,
      });
      if (options?.findByNonce !== undefined) {
        return Promise.resolve(options.findByNonce(input.nonce));
      }
      if (listOverride?.kind === 'incomplete') {
        return Promise.resolve(listOverride);
      }
      const match = transfers.find((transfer) => transfer.nonce === input.nonce);
      if (match === undefined) {
        return Promise.resolve({ kind: 'not_found' as const });
      }
      return Promise.resolve({ kind: 'found' as const, transfer: match });
    },
    listOutgoingTransfers(input) {
      listCalls.push({
        fromAddress: input.fromAddress,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
      if (listOverride !== undefined) {
        if (listOverride.kind === 'ok') {
          return Promise.resolve({
            ...listOverride,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
          });
        }
        return Promise.resolve(listOverride);
      }
      const inWindow = transfers.filter(
        (transfer) => transfer.blockNumber >= input.fromBlock && transfer.blockNumber <= input.toBlock,
      );
      return Promise.resolve({
        kind: 'ok' as const,
        transfers: inWindow,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
    },
  };
}

/** Builds a ReconciliationFundingQuery over in-memory funding transaction rows. */
export function createInMemoryReconciliationFundingQuery(
  txsById: Map<string, FundingTransaction>,
): ReconciliationFundingQuery {
  return {
    listSubmissionUnknownByTreasury(treasuryId) {
      return Promise.resolve(
        [...txsById.values()].filter(
          (tx) => tx.treasuryId === treasuryId && tx.status === 'submission_unknown',
        ),
      );
    },
    listRecordedTransactionHashesByTreasury(treasuryId) {
      const hashes: string[] = [];
      for (const tx of txsById.values()) {
        if (tx.treasuryId === treasuryId && tx.transactionHash !== undefined) {
          hashes.push(tx.transactionHash.toLowerCase());
        }
      }
      return Promise.resolve(hashes);
    },
  };
}
