import type { BalanceReading } from '../domain/balance-reading.js';
import type { Role } from '../domain/auth/roles.js';
import type { TreasuryStatus, TreasuryThresholds } from '../domain/treasury/treasury-status.js';

/**
 * Interfaces the application layer depends on. Infrastructure adapters
 * implement these; nothing here references Fastify, Drizzle, Viem, or Resend.
 */

export interface ChainDescriptor {
  readonly id: string;
  readonly slug: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
  readonly explorerBaseUrl: string;
}

export interface Treasury {
  readonly id: string;
  readonly chain: ChainDescriptor;
  readonly address: string;
  readonly addressDisplay: string;
  readonly thresholds: TreasuryThresholds;
  readonly status: TreasuryStatus;
  readonly lastObservedBalanceWei: bigint | undefined;
  readonly lastObservedAt: Date | undefined;
  readonly lastCheckedAt: Date | undefined;
  readonly lastCheckErrorCode: string | undefined;
  readonly enabled: boolean;
}

export interface ChainRegistration {
  readonly slug: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
  readonly explorerBaseUrl: string;
}

export interface TreasuryRegistration {
  readonly chainRowId: string;
  readonly address: string;
  readonly addressDisplay: string;
  readonly thresholds: TreasuryThresholds;
}

export interface RecordCheckSuccessInput {
  readonly treasuryId: string;
  readonly balanceWei: bigint;
  readonly status: TreasuryStatus;
  readonly observedAt: Date;
}

export interface RecordCheckFailureInput {
  readonly treasuryId: string;
  readonly errorCode: string;
  readonly checkedAt: Date;
}

export interface ChainRepository {
  /** Idempotently reconciles the configured chain into the database. */
  upsert(registration: ChainRegistration): Promise<ChainDescriptor>;
}

export interface TreasuryRepository {
  /** Idempotently reconciles the configured treasury into the database. */
  upsert(registration: TreasuryRegistration): Promise<Treasury>;
  findById(id: string): Promise<Treasury | undefined>;
  listEnabled(): Promise<readonly Treasury[]>;
  /**
   * Records a successful reading. Advances both the attempt and observation
   * timestamps and clears any previous failure code.
   */
  recordCheckSuccess(input: RecordCheckSuccessInput): Promise<Treasury>;
  /**
   * Records a failed attempt. Sets status to `unknown` and leaves the last
   * known balance untouched, so a failed read never becomes a zero balance.
   */
  recordCheckFailure(input: RecordCheckFailureInput): Promise<Treasury>;
}

export interface BalanceObservationInput {
  readonly chainRowId: string;
  readonly walletAddress: string;
  readonly walletType: 'treasury' | 'managed_wallet';
  readonly balanceWei: bigint;
  readonly blockNumber: bigint;
  readonly observedAt: Date;
  readonly sourceOperationId: string | undefined;
}

export interface BalanceObservationRepository {
  record(input: BalanceObservationInput): Promise<void>;
  findLatest(chainRowId: string, walletAddress: string): Promise<BalanceObservationSummary | undefined>;
}

export interface BalanceObservationSummary {
  readonly balanceWei: bigint;
  readonly blockNumber: bigint;
  readonly observedAt: Date;
}

export interface ApiCredential {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly enabled: boolean;
  readonly revokedAt: Date | undefined;
}

export interface ApiCredentialRepository {
  findByTokenHash(tokenHash: string): Promise<ApiCredential | undefined>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}

export interface AuditEventInput {
  readonly actorType: 'api_credential' | 'cron' | 'system';
  readonly actorId: string | undefined;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | undefined;
  readonly requestId: string | undefined;
  readonly sourceIp: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventRepository {
  record(input: AuditEventInput): Promise<void>;
}

export interface ServiceHeartbeat {
  readonly serviceRole: string;
  readonly lastSeenAt: Date;
  readonly lastOperationId: string | undefined;
}

export interface ServiceHeartbeatRepository {
  /** Writes this process's row. Used to prove shared-database operation. */
  upsert(input: {
    readonly serviceRole: string;
    readonly lastSeenAt: Date;
    readonly lastOperationId: string | undefined;
    readonly detail: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  list(): Promise<readonly ServiceHeartbeat[]>;
}

/**
 * Read-only chain access.
 *
 * Phase 0 deliberately exposes no signing counterpart. There is no interface
 * here through which any caller could submit a transaction.
 */
export interface BalanceReader {
  /** Never throws for provider failure; returns an `unavailable` reading instead. */
  readBalance(address: string): Promise<BalanceReading>;
  /** Confirms the connected RPC reports the configured chain ID. */
  verifyChainId(): Promise<{ readonly matches: boolean; readonly observedChainId: number | undefined }>;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type EmailSendResult =
  | { readonly kind: 'sent'; readonly providerMessageId: string | undefined }
  | { readonly kind: 'failed'; readonly errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_PROVIDER_REJECTED'; readonly reason: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
