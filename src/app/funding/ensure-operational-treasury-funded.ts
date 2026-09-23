import { fundingAuditActor, type RequestAuditActorType } from '../auth/request-audit-actor.js';
import type { Role } from '../../domain/auth/roles.js';
import { ChainBankError } from '../../domain/errors.js';
import { assertNever } from '../../domain/funding/statuses.js';
import type { FundingPolicy } from '../../domain/funding/funding-math.js';
import {
  resolveOperationalTreasury,
  resolveReplenishSource,
  throwTreasuryResolution,
} from '../../domain/treasury/resolve-treasury.js';
import type { Logger } from '../../observability/logger.js';
import {
  notifyTreasuryReserveRefusal,
  resolveTreasuryReserveAlert,
} from '../alerts/notify-treasury-reserve-alert.js';
import type {
  AlertRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  ChainAdapterRegistry,
  EmailSender,
  FundingDispatchLock,
  FundingOperationRepository,
  FundingTransaction,
  FundingTransactionRepository,
  ManagedWalletRepository,
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

export type ReplenishOperationalStatus = 'no-op' | 'funded' | 'pending' | 'blocked' | 'failed';

export interface EnsureOperationalTreasuryFundedDependencies {
  readonly treasuries: TreasuryRepository;
  readonly balanceObservations: BalanceObservationRepository;
  readonly chainAdapters: ChainAdapterRegistry;
  readonly auditEvents: AuditEventRepository;
  readonly alerts: AlertRepository;
  readonly emailSender: EmailSender | undefined;
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
  readonly managedWallets: ManagedWalletRepository;
  readonly lock: FundingDispatchLock;
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

export interface EnsureOperationalTreasuryFundedInput {
  readonly operationalTreasuryId: string;
  readonly idempotencyKey: string;
  readonly role: Role;
  readonly credentialId: string;
  /**
   * Request actor kind. `cron-reconciler` stays `cron` regardless of this
   * field, so the scheduled sweep is not attributed to a dashboard session.
   */
  readonly actorType?: RequestAuditActorType;
  readonly correlationId: string;
  readonly sourceIp: string | undefined;
}

export interface EnsureOperationalTreasuryFundedResult {
  readonly status: ReplenishOperationalStatus;
  readonly operationId: string;
  readonly sourceTreasuryId: string;
  readonly destinationTreasuryId: string;
  readonly balanceBeforeWei: bigint;
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly transferredWei: bigint | undefined;
  readonly transactionHash: string | undefined;
  readonly explorerBaseUrl: string;
  readonly reasonCode: string | undefined;
}

/**
 * Tops up the Private (operational) treasury from the Public (external) treasury
 * (C24 / P9-US2). Destination is the operational row — never a request address.
 */
export async function ensureOperationalTreasuryFunded(
  dependencies: EnsureOperationalTreasuryFundedDependencies,
  input: EnsureOperationalTreasuryFundedInput,
): Promise<EnsureOperationalTreasuryFundedResult> {
  const operational = await dependencies.treasuries.findById(input.operationalTreasuryId);
  if (operational === undefined) {
    throw new ChainBankError('TREASURY_NOT_FOUND', `Treasury ${input.operationalTreasuryId} does not exist`, {
      publicMessage: 'The treasury was not found.',
    });
  }
  if (operational.kind !== 'operational') {
    throw new ChainBankError(
      'INVALID_REQUEST',
      `Treasury ${operational.id} is ${operational.kind}; replenish targets the operational treasury only`,
      { publicMessage: 'Only the Private treasury can be replenished from the Public treasury.' },
    );
  }

  const enabled = await dependencies.treasuries.listEnabled();
  const source = throwTreasuryResolution(resolveReplenishSource(enabled, operational.chain.chainId));
  const resolvedOperational = throwTreasuryResolution(
    resolveOperationalTreasury(enabled, operational.chain.chainId),
  );
  if (resolvedOperational.id !== operational.id) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `Requested operational treasury ${operational.id} is not the enabled operational treasury ${resolvedOperational.id}`,
      { publicMessage: 'Funding is unavailable because treasury configuration is ambiguous for this chain.' },
    );
  }

  assertFundingArmed(dependencies);
  const policy = requireOperationalPolicy(operational);

  const destReading = await dependencies.chainAdapters.balanceReader(operational.chain.chainId).readBalance({
    chainId: operational.chain.chainId,
    address: operational.addressDisplay,
  });
  if (destReading.kind === 'unavailable') {
    throw new ChainBankError(destReading.errorCode, destReading.reason, {
      publicMessage: 'The Private treasury balance could not be read from the chain.',
      context: { treasuryId: operational.id },
    });
  }

  const sourceReading = await dependencies.chainAdapters.balanceReader(source.chain.chainId).readBalance({
    chainId: source.chain.chainId,
    address: source.addressDisplay,
  });
  if (sourceReading.kind === 'unavailable') {
    throw new ChainBankError(sourceReading.errorCode, sourceReading.reason, {
      publicMessage: 'The Public treasury balance could not be read from the chain.',
      context: { treasuryId: source.id },
    });
  }

  await dependencies.balanceObservations.record({
    chainRowId: operational.chain.id,
    walletAddress: operational.address,
    walletType: 'treasury',
    balanceWei: destReading.balanceWei,
    blockNumber: destReading.blockNumber,
    observedAt: destReading.observedAt,
    sourceOperationId: input.correlationId,
  });
  await dependencies.balanceObservations.record({
    chainRowId: source.chain.id,
    walletAddress: source.address,
    walletType: 'treasury',
    balanceWei: sourceReading.balanceWei,
    blockNumber: sourceReading.blockNumber,
    observedAt: sourceReading.observedAt,
    sourceOperationId: input.correlationId,
  });

  const signer = dependencies.chainAdapters.externalSigner(source.chain.chainId);
  if (signer === undefined) {
    throw new ChainBankError(
      'SIGNER_UNAVAILABLE',
      'Funding is enabled but no Public treasury signer is configured for this process.',
      { publicMessage: 'Funding is unavailable because the treasury signer is not configured.' },
    );
  }
  assertSignerMatchesTreasury(signer, source);

  try {
    const dispatchResult = await dispatchFunding(
      {
        operations: dependencies.operations,
        transactions: dependencies.transactions,
        managedWallets: dependencies.managedWallets,
        lock: dependencies.lock,
        signer,
        chainAdapters: dependencies.chainAdapters,
        clock: dependencies.clock,
        idGenerator: dependencies.idGenerator,
        logger: dependencies.logger,
        isFundingEnabled: dependencies.isFundingEnabled,
        isFundingKillSwitchActive: dependencies.isFundingKillSwitchActive,
      },
      {
        operationType: 'replenish_operational',
        projectId: undefined,
        environmentId: undefined,
        idempotencyKey: `replenish:${operational.id}:${input.idempotencyKey}`,
        requestedBy: input.credentialId,
        correlationId: input.correlationId,
        treasury: {
          id: source.id,
          evmChainId: source.chain.chainId,
          enabled: source.enabled,
          reserveWei: source.thresholds.minimumReserveWei,
          address: source.addressDisplay,
          balanceWei: sourceReading.balanceWei,
        },
        destination: {
          kind: 'operational_treasury',
          treasuryId: operational.id,
          address: operational.address,
          addressDisplay: operational.addressDisplay,
          enabled: operational.enabled,
        },
        projectEnabled: true,
        environmentEnabled: true,
        policy,
        walletBalanceWei: destReading.balanceWei,
      },
    );

    await maybeNotifyReserveAlert(dependencies, {
      dispatchResult,
      source,
      operational,
      sourceBalanceWei: sourceReading.balanceWei,
      policy,
      destBalanceWei: destReading.balanceWei,
      correlationId: input.correlationId,
      credentialId: input.credentialId,
      role: input.role,
      ...(input.actorType === undefined ? {} : { actorType: input.actorType }),
    });

    const result = await mapDispatchOutcome(dependencies, {
      dispatchResult,
      source,
      operational,
      balanceBeforeWei: destReading.balanceWei,
      policy,
      correlationId: input.correlationId,
    });

    await recordAttemptAudit(dependencies, input, operational, source, {
      outcome: result.status,
      operationId: result.operationId,
      reasonCode: result.reasonCode,
    });

    return result;
  } catch (error) {
    await recordAttemptAudit(dependencies, input, operational, source, {
      outcome: 'error',
      errorCode: error instanceof ChainBankError ? error.code : 'INTERNAL_ERROR',
    });
    throw error;
  }
}

function requireOperationalPolicy(treasury: Treasury): FundingPolicy {
  if (treasury.policy === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `Operational treasury ${treasury.id} has no funding policy`,
      {
        publicMessage: 'The Private treasury has no refill policy configured.',
        context: { treasuryId: treasury.id },
      },
    );
  }
  return {
    minimumBalanceWei: treasury.policy.minimumBalanceWei,
    targetBalanceWei: treasury.policy.targetBalanceWei,
    maximumTopUpWei: treasury.policy.maximumTopUpWei,
    isEnabled: true,
  };
}

function assertFundingArmed(dependencies: EnsureOperationalTreasuryFundedDependencies): void {
  if (!dependencies.isFundingEnabled) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_ENABLED is false; refusing replenish.', {
      publicMessage: 'Funding is disabled.',
    });
  }
  if (dependencies.isFundingKillSwitchActive) {
    throw new ChainBankError('FUNDING_DISABLED', 'FUNDING_KILL_SWITCH is active; refusing replenish.', {
      publicMessage: 'Funding is temporarily disabled.',
    });
  }
}

function assertSignerMatchesTreasury(signer: TreasurySigner, treasury: Treasury): void {
  if (
    signer.chainId !== treasury.chain.chainId ||
    signer.address.toLowerCase() !== treasury.address.toLowerCase()
  ) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'Treasury signing key does not match the configured treasury address; refusing to sign.',
      {
        publicMessage: 'Funding is unavailable because the treasury signer is misconfigured.',
        context: { treasuryId: treasury.id },
      },
    );
  }
}

async function maybeNotifyReserveAlert(
  dependencies: EnsureOperationalTreasuryFundedDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly source: Treasury;
    readonly operational: Treasury;
    readonly sourceBalanceWei: bigint;
    readonly policy: FundingPolicy;
    readonly destBalanceWei: bigint;
    readonly correlationId: string;
    readonly credentialId: string;
    readonly role: Role;
    readonly actorType?: RequestAuditActorType;
  },
): Promise<void> {
  const actor = fundingAuditActor(input);

  try {
    if (input.dispatchResult.kind === 'blocked' && input.dispatchResult.reason === 'reserve') {
      const requestedAmountWei = provisionalTopUpAmountWei({
        walletBalanceWei: input.destBalanceWei,
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
          treasury: input.source,
          treasuryBalanceWei: input.sourceBalanceWei,
          managedWalletAddressDisplay: input.operational.addressDisplay,
          managedWalletId: input.operational.id,
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

    if (input.dispatchResult.kind === 'submitted') {
      await resolveTreasuryReserveAlert(
        {
          alerts: dependencies.alerts,
          auditEvents: dependencies.auditEvents,
          clock: dependencies.clock,
        },
        {
          treasuryId: input.source.id,
          operationId: input.correlationId,
          actor,
        },
      );
    }
  } catch (error) {
    dependencies.logger.error(
      {
        event: 'treasury.reserve_alert.notification_failed',
        treasuryId: input.source.id,
        operationId: input.correlationId,
        dispatchKind: input.dispatchResult.kind,
        err:
          error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
      },
      'Reserve alert notification failed; replenish outcome unchanged',
    );
  }
}

async function mapDispatchOutcome(
  dependencies: EnsureOperationalTreasuryFundedDependencies,
  input: {
    readonly dispatchResult: DispatchFundingResult;
    readonly source: Treasury;
    readonly operational: Treasury;
    readonly balanceBeforeWei: bigint;
    readonly policy: FundingPolicy;
    readonly correlationId: string;
  },
): Promise<EnsureOperationalTreasuryFundedResult> {
  const base = {
    sourceTreasuryId: input.source.id,
    destinationTreasuryId: input.operational.id,
    balanceBeforeWei: input.balanceBeforeWei,
    minimumBalanceWei: input.policy.minimumBalanceWei,
    targetBalanceWei: input.policy.targetBalanceWei,
    explorerBaseUrl: input.operational.chain.explorerBaseUrl,
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
          receiptTracker: dependencies.chainAdapters.receiptTracker(input.source.chain.chainId),
          clock: dependencies.clock,
          logger: dependencies.logger,
          confirmations: dependencies.confirmations,
          confirmationTimeoutMs: dependencies.confirmationTimeoutMs,
        },
        {
          transactionId: input.dispatchResult.transaction.id,
          correlationId: input.correlationId,
          senderAddress: input.source.addressDisplay,
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
    readonly sourceTreasuryId: string;
    readonly destinationTreasuryId: string;
    readonly balanceBeforeWei: bigint;
    readonly minimumBalanceWei: bigint;
    readonly targetBalanceWei: bigint;
    readonly explorerBaseUrl: string;
  },
  operationId: string,
  transaction: FundingTransaction | undefined,
): EnsureOperationalTreasuryFundedResult {
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
  dependencies: EnsureOperationalTreasuryFundedDependencies,
  input: EnsureOperationalTreasuryFundedInput,
  operational: Treasury,
  source: Treasury,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  const actor = fundingAuditActor(input);
  await dependencies.auditEvents.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'treasury.replenish_operational',
    entityType: 'treasury',
    entityId: operational.id,
    requestId: input.correlationId,
    sourceIp: input.sourceIp,
    metadata: {
      role: input.role,
      sourceTreasuryId: source.id,
      ...metadata,
    },
  });
}
