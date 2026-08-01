import type { Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { FundingPolicy } from '../../domain/funding/funding-math.js';
import type { Logger } from '../../observability/logger.js';
import {
  notifyTreasuryReserveRefusal,
  resolveTreasuryReserveAlert,
} from '../alerts/notify-treasury-reserve-alert.js';
import { authorizeScope } from '../auth/authorize-scope.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  CredentialScopeRepository,
  EmailSender,
  FundingDispatchLock,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  ManagedWallet,
  ManagedWalletRepository,
  TransactionReceiptTracker,
  Treasury,
  TreasuryRepository,
  TreasurySigner,
} from '../ports.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import {
  dispatchFunding,
  provisionalTopUpAmountWei,
  type DispatchFundingResult,
} from './dispatch-funding.js';
import { trackTransaction } from './track-transaction.js';

export type EnsureFundedStatus = 'no-op' | 'funded' | 'pending' | 'blocked' | 'failed';

export interface EnsureWalletFundedDependencies {
  readonly managedWallets: ManagedWalletRepository;
  readonly treasuries: TreasuryRepository;
  readonly balanceObservations: BalanceObservationRepository;
  readonly balanceReader: BalanceReader;
  readonly credentialScopes: CredentialScopeRepository;
  readonly auditEvents: AuditEventRepository;
  readonly alerts: AlertRepository;
  readonly emailSender: EmailSender | undefined;
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly lock: FundingDispatchLock;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly signer: TreasurySigner | undefined;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly isFundingEnabled: boolean;
  readonly isFundingKillSwitchActive: boolean;
  readonly confirmations: number;
  readonly confirmationTimeoutMs: number;
  readonly operatorRecipients: readonly string[];
  readonly dashboardBaseUrl: string;
  readonly environment: string;
}

export interface EnsureWalletFundedInput {
  readonly walletId: string;
  readonly idempotencyKey: string;
  readonly role: Role;
  readonly credentialId: string;
  readonly correlationId: string;
  readonly sourceIp: string | undefined;
}

export interface EnsureWalletFundedResult {
  readonly status: EnsureFundedStatus;
  readonly operationId: string;
  readonly balanceBeforeWei: bigint;
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly transferredWei: bigint | undefined;
  readonly transactionHash: string | undefined;
  readonly explorerBaseUrl: string;
  readonly reasonCode: string | undefined;
}

/**
 * On-demand funding for one managed wallet (PRD P1-US3).
 *
 * Security order:
 * 1. Load wallet by id (404) — destination address never comes from the request.
 * 2. Authorize operator / scoped project-service; deny read-only and cron.
 * 3. Refuse when funding is disabled or the kill switch is active (no signer touch).
 * 4. Fresh on-chain balance reads for wallet and treasury (never trust stored observations).
 * 5. Dispatch under the existing lock/idempotency engine, then wait for confirmations.
 */
export async function ensureWalletFunded(
  dependencies: EnsureWalletFundedDependencies,
  input: EnsureWalletFundedInput,
): Promise<EnsureWalletFundedResult> {
  const wallet = await dependencies.managedWallets.findById(input.walletId);
  if (wallet === undefined) {
    throw new ChainBankError('WALLET_NOT_FOUND', `Managed wallet ${input.walletId} does not exist`, {
      publicMessage: 'The managed wallet was not found.',
    });
  }

  await authorizeScope(
    { credentialScopes: dependencies.credentialScopes },
    {
      role: input.role,
      credentialId: input.credentialId,
      action: 'fund',
      projectId: wallet.project.id,
      environmentId: wallet.environment.id,
    },
  );

  // Every authorized attempt is audited, including disabled/kill-switch refusals.
  try {
    const policy = requireFundingPolicy(wallet);

    // Fail closed before any RPC or signer construction path.
    assertFundingArmed(dependencies);

    const treasury = await resolveTreasuryForWallet(dependencies, wallet);
    const walletReading = await dependencies.balanceReader.readBalance(wallet.addressDisplay);
    if (walletReading.kind === 'unavailable') {
      throw new ChainBankError(walletReading.errorCode, walletReading.reason, {
        publicMessage: 'The managed wallet balance could not be read from the chain.',
        context: { managedWalletId: wallet.id },
      });
    }

    const treasuryReading = await dependencies.balanceReader.readBalance(treasury.address);
    if (treasuryReading.kind === 'unavailable') {
      throw new ChainBankError(treasuryReading.errorCode, treasuryReading.reason, {
        publicMessage: 'The treasury balance could not be read from the chain.',
        context: { treasuryId: treasury.id },
      });
    }

    await dependencies.balanceObservations.record({
      chainRowId: wallet.chain.id,
      walletAddress: wallet.address,
      walletType: 'managed_wallet',
      balanceWei: walletReading.balanceWei,
      blockNumber: walletReading.blockNumber,
      observedAt: walletReading.observedAt,
      sourceOperationId: input.correlationId,
    });
    await dependencies.balanceObservations.record({
      chainRowId: treasury.chain.id,
      walletAddress: treasury.address,
      walletType: 'treasury',
      balanceWei: treasuryReading.balanceWei,
      blockNumber: treasuryReading.blockNumber,
      observedAt: treasuryReading.observedAt,
      sourceOperationId: input.correlationId,
    });

    const signer = dependencies.signer;
    if (signer === undefined) {
      throw new ChainBankError(
        'SIGNER_UNAVAILABLE',
        'Funding is enabled but no treasury signer is configured for this process.',
        { publicMessage: 'Funding is unavailable because the treasury signer is not configured.' },
      );
    }

    assertSignerMatchesTreasury(signer, treasury);

    const dispatchResult = await dispatchFunding(
      {
        operations: dependencies.operations,
        transactions: dependencies.transactions,
        managedWallets: dependencies.managedWallets,
        lock: dependencies.lock,
        signer,
        clock: dependencies.clock,
        idGenerator: dependencies.idGenerator,
        logger: dependencies.logger,
        isFundingEnabled: dependencies.isFundingEnabled,
        isFundingKillSwitchActive: dependencies.isFundingKillSwitchActive,
      },
      {
        operationType: 'ensure_funded',
        projectId: wallet.project.id,
        environmentId: wallet.environment.id,
        // Namespaced by wallet so one caller reusing a key across wallets
        // cannot replay a different wallet's transfer and be told the wallet in
        // hand was funded. The stored key stays unique per (credential, key).
        idempotencyKey: `${wallet.id}:${input.idempotencyKey}`,
        requestedBy: input.credentialId,
        correlationId: input.correlationId,
        treasury: {
          id: treasury.id,
          evmChainId: treasury.chain.chainId,
          enabled: treasury.enabled,
          reserveWei: treasury.thresholds.minimumReserveWei,
          balanceWei: treasuryReading.balanceWei,
        },
        walletId: wallet.id,
        projectEnabled: wallet.project.enabled,
        environmentEnabled: wallet.environment.enabled,
        policy,
        walletBalanceWei: walletReading.balanceWei,
      },
    );

    // Reserve alert is best-effort: never mask FUNDING_BLOCKED_RESERVE or
    // convert a correct refusal into a different caller-visible error (T1.8).
    await maybeNotifyReserveAlert(dependencies, {
      dispatchResult,
      wallet,
      treasury,
      treasuryBalanceWei: treasuryReading.balanceWei,
      policy,
      walletBalanceWei: walletReading.balanceWei,
      correlationId: input.correlationId,
      credentialId: input.credentialId,
    });

    const result = await mapDispatchOutcome(dependencies, {
      dispatchResult,
      wallet,
      treasury,
      balanceBeforeWei: walletReading.balanceWei,
      policy,
      correlationId: input.correlationId,
    });

    await recordAttemptAudit(dependencies, input, wallet, {
      outcome: result.status,
      operationId: result.operationId,
      reasonCode: result.reasonCode,
    });

    return result;
  } catch (error) {
    await recordAttemptAudit(dependencies, input, wallet, {
      outcome: 'error',
      errorCode: error instanceof ChainBankError ? error.code : 'INTERNAL_ERROR',
    });
    throw error;
  }
}

function requireFundingPolicy(wallet: ManagedWallet): FundingPolicy {
  if (wallet.policy === undefined) {
    throw new ChainBankError('INVALID_REQUEST', `Managed wallet ${wallet.id} has no funding policy`, {
      publicMessage: 'A funding policy must be configured before this wallet can be funded.',
      context: { managedWalletId: wallet.id },
    });
  }
  return {
    minimumBalanceWei: wallet.policy.minimumBalanceWei,
    targetBalanceWei: wallet.policy.targetBalanceWei,
    maximumTopUpWei: wallet.policy.maximumTopUpWei,
    // Entity enable flags are enforced separately; policy amounts stay active when present.
    isEnabled: true,
  };
}

function assertFundingArmed(dependencies: EnsureWalletFundedDependencies): void {
  if (!dependencies.isFundingEnabled) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_ENABLED is false; refusing ensure-funded.', {
      publicMessage: 'Funding is disabled.',
    });
  }
  if (dependencies.isFundingKillSwitchActive) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_KILL_SWITCH is active; refusing ensure-funded.', {
      publicMessage: 'Funding is temporarily disabled.',
    });
  }
}

/**
 * Refuses to spend unless the signing account IS the treasury whose reserve is
 * being enforced.
 *
 * The treasury row's address and the signing key arrive as independent
 * configuration (`TREASURY_ADDRESS` and `TREASURY_PRIVATE_KEY`). If they ever
 * diverge — a rotated key, a staging key in production — then the balance read,
 * the reserve floor, the in-flight accounting, and the nonce probe all describe
 * an account that is not the one spending, and every gate reports healthy while
 * the real treasury drains. Compared case-insensitively because one side is
 * checksummed and the other is stored normalized.
 */
function assertSignerMatchesTreasury(signer: TreasurySigner, treasury: Treasury): void {
  if (signer.address.toLowerCase() !== treasury.address.toLowerCase()) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Treasury signing key does not match the configured treasury address; refusing to sign.',
      {
        publicMessage: 'Funding is unavailable because the treasury signer is misconfigured.',
        // The signer address is deliberately omitted: it is the public half of
        // the key this process holds, and the caller has no need for it.
        context: { treasuryId: treasury.id },
      },
    );
  }
}

/**
 * Side-effect notifications for reserve exhaustion / recovery. Failures are
 * logged only — the caller's dispatch outcome must remain unchanged.
 */
async function maybeNotifyReserveAlert(
  dependencies: EnsureWalletFundedDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly wallet: ManagedWallet;
    readonly treasury: Treasury;
    readonly treasuryBalanceWei: bigint;
    readonly policy: FundingPolicy;
    readonly walletBalanceWei: bigint;
    readonly correlationId: string;
    readonly credentialId: string;
  },
): Promise<void> {
  const actor = { type: 'api_credential' as const, id: input.credentialId };

  try {
    if (input.dispatchResult.kind === 'blocked' && input.dispatchResult.reason === 'reserve') {
      const requestedAmountWei = provisionalTopUpAmountWei({
        walletBalanceWei: input.walletBalanceWei,
        policy: input.policy,
      });

      await notifyTreasuryReserveRefusal(
        {
          alerts: dependencies.alerts,
          emailSender: dependencies.emailSender,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
          logger: dependencies.logger,
        },
        {
          treasury: input.treasury,
          treasuryBalanceWei: input.treasuryBalanceWei,
          managedWalletAddressDisplay: input.wallet.addressDisplay,
          managedWalletId: input.wallet.id,
          requestedAmountWei,
          operatorRecipients: dependencies.operatorRecipients,
          dashboardBaseUrl: dependencies.dashboardBaseUrl,
          environment: dependencies.environment,
          operationId: input.correlationId,
          actor,
        },
      );
      return;
    }

    // A successful submit proves spendable capacity again — resolve any open
    // reserve alert for this treasury (C10 resolution rule).
    if (input.dispatchResult.kind === 'submitted') {
      await resolveTreasuryReserveAlert(
        {
          alerts: dependencies.alerts,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
        },
        {
          treasuryId: input.treasury.id,
          operationId: input.correlationId,
          actor,
        },
      );
    }
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'treasury.reserve_alert.notification_failed',
        treasuryId: input.treasury.id,
        operationId: input.correlationId,
        dispatchKind: input.dispatchResult.kind,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Reserve alert notification failed; funding outcome unchanged',
    );
  }
}

async function resolveTreasuryForWallet(
  dependencies: EnsureWalletFundedDependencies,
  wallet: ManagedWallet,
): Promise<Treasury> {
  const treasuries = await dependencies.treasuries.listEnabled();
  const matches = treasuries.filter((row) => row.chain.chainId === wallet.chain.chainId);

  // More than one enabled row for a chain is the address-rotation hazard:
  // bootstrap upserts on (chain_id, address), so a new TREASURY_ADDRESS inserts
  // a second row while funding would otherwise keep binding the oldest. Refuse
  // before any signer call so the silent no-op cannot spend from the retired
  // treasury (TX.5 / AGENTS.md §18).
  if (matches.length > 1) {
    const ids = matches.map((row) => row.id).join(', ');
    const addresses = matches.map((row) => row.address).join(', ');
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `Ambiguous treasury configuration for chain ${String(wallet.chain.chainId)}: ${String(matches.length)} enabled rows (${ids}; addresses ${addresses}). Disable the retired row before funding.`,
      {
        publicMessage:
          'Funding is unavailable because treasury configuration is ambiguous for this chain.',
        context: {
          chainId: wallet.chain.chainId,
          managedWalletId: wallet.id,
          treasuryIds: matches.map((row) => row.id),
          treasuryAddresses: matches.map((row) => row.address),
        },
      },
    );
  }

  const treasury = matches[0];
  if (treasury === undefined) {
    throw new ChainBankError(
      'TREASURY_NOT_FOUND',
      `No enabled treasury is registered for chain ${String(wallet.chain.chainId)}`,
      {
        publicMessage: 'No enabled treasury is available for this wallet chain.',
        context: { chainId: wallet.chain.chainId, managedWalletId: wallet.id },
      },
    );
  }
  return treasury;
}

async function mapDispatchOutcome(
  dependencies: EnsureWalletFundedDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly wallet: ManagedWallet;
    readonly treasury: Treasury;
    readonly balanceBeforeWei: bigint;
    readonly policy: FundingPolicy;
    readonly correlationId: string;
  },
): Promise<EnsureWalletFundedResult> {
  const base = {
    balanceBeforeWei: input.balanceBeforeWei,
    minimumBalanceWei: input.policy.minimumBalanceWei,
    targetBalanceWei: input.policy.targetBalanceWei,
    explorerBaseUrl: input.wallet.chain.explorerBaseUrl,
  };

  switch (input.dispatchResult.kind) {
    case 'no-op':
      return {
        ...base,
        status: 'no-op',
        operationId: input.dispatchResult.operation.id,
        transferredWei: undefined,
        transactionHash: undefined,
        reasonCode: undefined,
      };
    case 'blocked': {
      // Map domain block reasons to stable machine-readable codes (P1-US5).
      const reasonCode =
        input.dispatchResult.reason === 'reserve' ? 'FUNDING_BLOCKED_RESERVE' : 'FUNDING_DISABLED';
      return {
        ...base,
        status: 'blocked',
        operationId: input.dispatchResult.operation.id,
        transferredWei: undefined,
        transactionHash: undefined,
        reasonCode,
      };
    }
    case 'replay':
      return mapReplayResult(base, input.dispatchResult.operation.id, input.dispatchResult.transaction);
    case 'submitted': {
      const tracked = await trackTransaction(
        {
          operations: dependencies.operations,
          transactions: dependencies.transactions,
          receiptTracker: dependencies.receiptTracker,
          clock: dependencies.clock,
          logger: dependencies.logger,
          confirmations: dependencies.confirmations,
          confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
        },
        {
          transactionId: input.dispatchResult.transaction.id,
          correlationId: input.correlationId,
          senderAddress: input.treasury.addressDisplay,
        },
      );

      switch (tracked.kind) {
        case 'confirmed':
        case 'already-terminal':
          if (tracked.transaction.status === 'confirmed') {
            return {
              ...base,
              status: 'funded',
              operationId: tracked.operation.id,
              transferredWei: tracked.transaction.amountWei,
              transactionHash: tracked.transaction.transactionHash,
              reasonCode: undefined,
            };
          }
          return {
            ...base,
            status: 'failed',
            operationId: tracked.operation.id,
            transferredWei: tracked.transaction.amountWei,
            transactionHash: tracked.transaction.transactionHash,
            reasonCode: tracked.transaction.errorCode ?? tracked.operation.errorCode,
          };
        case 'pending':
          return {
            ...base,
            status: 'pending',
            operationId: tracked.operation.id,
            transferredWei: tracked.transaction.amountWei,
            transactionHash: tracked.transaction.transactionHash,
            reasonCode: undefined,
          };
        case 'reverted':
        case 'replaced':
        case 'dropped':
          return {
            ...base,
            status: 'failed',
            operationId: tracked.operation.id,
            transferredWei: tracked.transaction.amountWei,
            transactionHash: tracked.transaction.transactionHash,
            reasonCode: tracked.transaction.errorCode ?? tracked.operation.errorCode,
          };
        default:
          return assertNever(tracked, 'TrackTransactionResult');
      }
    }
    default:
      return assertNever(input.dispatchResult, 'DispatchFundingResult');
  }
}

function mapReplayResult(
  base: {
    readonly balanceBeforeWei: bigint;
    readonly minimumBalanceWei: bigint;
    readonly targetBalanceWei: bigint;
    readonly explorerBaseUrl: string;
  },
  operationId: string,
  transaction: FundingTransaction | undefined,
): EnsureWalletFundedResult {
  if (transaction === undefined) {
    return {
      ...base,
      status: 'no-op',
      operationId,
      transferredWei: undefined,
      transactionHash: undefined,
      reasonCode: undefined,
    };
  }

  switch (transaction.status) {
    case 'confirmed':
      return {
        ...base,
        status: 'funded',
        operationId,
        transferredWei: transaction.amountWei,
        transactionHash: transaction.transactionHash,
        reasonCode: undefined,
      };
    case 'submitted':
    case 'created':
    case 'submission_unknown':
      return {
        ...base,
        status: 'pending',
        operationId,
        transferredWei: transaction.amountWei,
        transactionHash: transaction.transactionHash,
        reasonCode: undefined,
      };
    case 'reverted':
    case 'replaced':
    case 'dropped':
    case 'failed':
      return {
        ...base,
        status: transaction.errorCode === 'FUNDING_BLOCKED_RESERVE' ? 'blocked' : 'failed',
        operationId,
        transferredWei: transaction.amountWei,
        transactionHash: transaction.transactionHash,
        reasonCode: transaction.errorCode,
      };
    default:
      return assertNever(transaction.status, 'FundingTransactionStatus');
  }
}

async function recordAttemptAudit(
  dependencies: EnsureWalletFundedDependencies,
  input: EnsureWalletFundedInput,
  wallet: ManagedWallet,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.auditEvents.record({
    actorType: 'api_credential',
    actorId: input.credentialId,
    action: 'wallet.ensure_funded',
    entityType: 'managed_wallet',
    entityId: wallet.id,
    requestId: input.correlationId,
    sourceIp: input.sourceIp,
    metadata: {
      role: input.role,
      projectId: wallet.project.id,
      environmentId: wallet.environment.id,
      ...metadata,
    },
  });
}
