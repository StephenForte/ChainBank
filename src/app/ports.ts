import type { AlertSeverity } from '../domain/alerts/treasury-alert.js';
import type { BalanceReading } from '../domain/balance-reading.js';
import type { ScryptPasswordParams } from '../domain/auth/password.js';
import type { Role } from '../domain/auth/roles.js';
import type { DashboardRole } from '../domain/auth/users.js';
import type { FundingOperationStatus, FundingTransactionStatus } from '../domain/funding/statuses.js';
import type { TreasuryKind } from '../domain/treasury/treasury-kind.js';
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

export interface TreasuryFundingPolicyAmounts {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
}

export interface Treasury {
  readonly id: string;
  readonly chain: ChainDescriptor;
  readonly address: string;
  readonly addressDisplay: string;
  readonly kind: TreasuryKind;
  /** Present only for operational treasuries (C23). */
  readonly policy: TreasuryFundingPolicyAmounts | undefined;
  readonly thresholds: TreasuryThresholds;
  readonly status: TreasuryStatus;
  readonly lastObservedBalanceWei: bigint | undefined;
  readonly lastObservedAt: Date | undefined;
  readonly lastCheckedAt: Date | undefined;
  readonly lastCheckErrorCode: string | undefined;
  /** Highest block included in a complete outgoing scan (C14 / TX.9). */
  readonly lastOutgoingScanBlock: bigint | undefined;
  readonly lastOutgoingScanAt: Date | undefined;
  /**
   * Confirmed treasury nonce at `lastOutgoingScanBlock` (C14 / TX.14).
   * `undefined` means cannot-skip — never treat as equality with tip.
   */
  readonly lastOutgoingScanNonce: number | undefined;
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
  readonly kind: TreasuryKind;
  readonly thresholds: TreasuryThresholds;
  /** Required when kind is operational; ignored for external. */
  readonly policy: TreasuryFundingPolicyAmounts | undefined;
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

export interface RecordOutgoingScanCompleteInput {
  readonly treasuryId: string;
  /** Inclusive end block of a genuinely complete scan window. */
  readonly scannedToBlock: bigint;
  /**
   * Confirmed treasury transaction count at `scannedToBlock` (C14 / TX.14).
   * Written with the watermark; null stored rows cannot skip until seeded.
   */
  readonly scannedNonce: number;
  readonly scannedAt: Date;
}

export interface ChainRepository {
  /** Idempotently reconciles the configured chain into the database. */
  upsert(registration: ChainRegistration): Promise<ChainDescriptor>;
  /** Looks up a registered chain by its EVM chain ID. */
  findByNumericChainId(chainId: number): Promise<ChainDescriptor | undefined>;
}

export interface TreasuryRepository {
  /** Idempotently reconciles the configured treasury into the database. */
  upsert(registration: TreasuryRegistration): Promise<Treasury>;
  findById(id: string): Promise<Treasury | undefined>;
  listEnabled(): Promise<readonly Treasury[]>;
  /** Soft-enables or soft-disables a treasury row without deleting history. */
  setEnabled(id: string, enabled: boolean): Promise<Treasury>;
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
  /**
   * Advances the outgoing-scan watermark after a genuinely complete window.
   * Partial / failed scans must not call this (C14 / TX.9).
   */
  recordOutgoingScanComplete(input: RecordOutgoingScanCompleteInput): Promise<Treasury>;
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

/** Operator-facing credential metadata. Never includes token_hash. */
export interface ApiCredentialSummary {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly tokenPrefix: string;
  readonly enabled: boolean;
  readonly revokedAt: Date | undefined;
  readonly lastUsedAt: Date | undefined;
  readonly createdAt: Date;
}

export interface ApiCredentialListPage {
  readonly items: readonly ApiCredentialSummary[];
  readonly total: number;
}

export interface ApiCredentialRepository {
  findByTokenHash(tokenHash: string): Promise<ApiCredential | undefined>;
  findById(id: string): Promise<ApiCredentialSummary | undefined>;
  list(pagination: { readonly limit: number; readonly offset: number }): Promise<ApiCredentialListPage>;
  disable(id: string, at: Date): Promise<ApiCredentialSummary>;
  revoke(id: string, at: Date): Promise<ApiCredentialSummary>;
  /** Re-enables a disabled credential. Never clears `revoked_at`. */
  enable(id: string, at: Date): Promise<ApiCredentialSummary>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}

export interface DashboardUserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: DashboardRole;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastLoginAt: Date | undefined;
}

/** Includes the password hash. Never return this from an HTTP handler. */
export interface DashboardUserRecord extends DashboardUserSummary {
  readonly passwordHash: string;
  readonly passwordParams: ScryptPasswordParams;
}

export interface DashboardUserListPage {
  readonly items: readonly DashboardUserSummary[];
  readonly total: number;
}

export interface DashboardUserInsert {
  readonly email: string;
  readonly displayName: string;
  readonly role: DashboardRole;
  readonly passwordHash: string;
  readonly passwordParams: ScryptPasswordParams;
  readonly now: Date;
}

export interface DashboardUserPatch {
  readonly role?: DashboardRole;
  readonly enabled?: boolean;
  readonly passwordHash?: string;
  readonly passwordParams?: ScryptPasswordParams;
  readonly updatedAt: Date;
}

export interface DashboardUserRepository {
  findByEmail(email: string): Promise<DashboardUserRecord | undefined>;
  findById(id: string): Promise<DashboardUserRecord | undefined>;
  list(pagination: { readonly limit: number; readonly offset: number }): Promise<DashboardUserListPage>;
  insert(input: DashboardUserInsert): Promise<DashboardUserSummary>;
  update(id: string, patch: DashboardUserPatch): Promise<DashboardUserSummary | undefined>;
  recordLogin(id: string, at: Date): Promise<void>;
}

export interface DashboardSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | undefined;
}

export interface DashboardSessionRepository {
  insert(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly lastSeenAt: Date;
  }): Promise<DashboardSessionRecord>;
  findByTokenHash(tokenHash: string): Promise<DashboardSessionRecord | undefined>;
  /**
   * Slides `last_seen_at` only while the row is unrevoked, inside absolute
   * expiry, and inside the idle window. Zero rows means do not resurrect.
   */
  touchIfActive(input: {
    readonly id: string;
    readonly now: Date;
    readonly idleCutoff: Date;
  }): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
  /** Revokes every other live session for the user. The current session stays. */
  revokeOthers(userId: string, exceptSessionId: string, at: Date): Promise<void>;
  /** Revokes every live session for the user, including the one in use. */
  revokeAll(userId: string, at: Date): Promise<void>;
}

export interface AuditEventInput {
  readonly actorType: 'api_credential' | 'cron' | 'system' | 'dashboard_user';
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
 * Signing capability lives behind {@link TreasurySigner}, constructed only in
 * signing-capable processes. BalanceReader must never submit a transaction.
 *
 * Each reader is bound to one chain. Callers obtain it from
 * {@link ChainAdapterRegistry} by naming that chain — never from a process-global
 * default. A read that names a different chain throws rather than returning a
 * balance from this reader's RPC (C26).
 */
export interface BalanceReadRequest {
  readonly chainId: number;
  readonly address: string;
}

export interface BalanceReader {
  /** EVM chain id this reader is bound to. */
  readonly chainId: number;
  /**
   * Never throws for provider failure; returns an `unavailable` reading instead.
   * Throws `INVALID_CONFIGURATION` when `request.chainId` is not this reader's chain.
   */
  readBalance(request: BalanceReadRequest): Promise<BalanceReading>;
  /** Confirms the connected RPC reports the configured chain ID. */
  verifyChainId(): Promise<{ readonly matches: boolean; readonly observedChainId: number | undefined }>;
}

/**
 * Treasury transaction signing port (DECISIONS.md contract C1).
 *
 * Implementations must fail closed: refuse on chain-ID mismatch, kill switch,
 * absent/malformed key, or gas-estimation failure. Destination allowlisting is
 * the caller's responsibility; this port assumes a pre-validated address.
 */
export interface TreasurySigner {
  /** Fails closed: throws SIGNER_UNAVAILABLE if key config is absent/malformed. */
  readonly address: string;
  /** EVM chain id this signer broadcasts on. Part of the C26 lookup key. */
  readonly chainId: number;
  sendNativeTransfer(input: {
    readonly to: string;
    readonly valueWei: bigint;
    readonly nonce: number;
  }): Promise<{ readonly transactionHash: string }>;
  getTransactionCount(): Promise<number>;
  /** Fails closed when gas estimation fails — no fallback constant. */
  estimateTransferCostWei(to: string, valueWei: bigint): Promise<bigint>;
  verifyChainId(): Promise<{ readonly matches: boolean; readonly observedChainId: number | undefined }>;
}

/**
 * C26 — the only way to obtain a balance reader, receipt tracker, outgoing
 * scanner, or treasury signer.
 *
 * Every method that selects an adapter takes a chain id. An unregistered chain
 * throws `INVALID_CONFIGURATION`. There is no default and no "first registered
 * chain" fallback: with one chain today that fallback would be invisible, and
 * on the day a second chain is registered it would send on the wrong RPC.
 *
 * Signer resolution is `(chain, address)`. Address-only matching is unsafe
 * because the same EOA is a legal treasury on two chains.
 */
export interface ChainAdapterRegistry {
  /** Insertion order. Readiness verifies each of these. */
  readonly registeredChainIds: readonly number[];
  /**
   * True when this process constructed at least one treasury signer.
   * Read-only roles are false. This does not select a signer.
   */
  readonly canSign: boolean;
  balanceReader(chainId: number): BalanceReader;
  receiptTracker(chainId: number): TransactionReceiptTracker;
  outgoingScanner(chainId: number): TreasuryOutgoingScanner;
  /**
   * Signer bound to this treasury's chain and address.
   * Unregistered chain, or no signer for that pair while {@link canSign} is
   * true, throws `INVALID_CONFIGURATION`. A process with no signing
   * credentials throws `SIGNER_UNAVAILABLE`. Never returns another chain's signer.
   */
  getSignerForTreasury(treasury: {
    readonly id: string;
    readonly address: string;
    readonly chain: { readonly chainId: number };
  }): TreasurySigner;
  /**
   * Public-treasury signer for replenish on this chain (C25), or `undefined`
   * when this chain has no external key. Unregistered chain id throws
   * `INVALID_CONFIGURATION`.
   */
  externalSigner(chainId: number): TreasurySigner | undefined;
}

/**
 * Template names that can be recorded on `email_deliveries` (C35).
 * Treasury balance kinds are the names of {@link PendingAlertEmail}, not a
 * second vocabulary: warning → treasury_warning, and so on.
 * A send that omits `kind` is stored as `unknown`.
 */
export const EMAIL_DELIVERY_KINDS = [
  'treasury_warning',
  'treasury_critical',
  'treasury_recovery',
  'treasury_unresolved_reminder',
  'treasury_finding',
  'reconciliation_failure',
  'funding_unavailable_reserve',
  'test_email',
] as const;

export type EmailDeliveryKind = (typeof EMAIL_DELIVERY_KINDS)[number];

/** Stored when a message does not name a {@link EmailDeliveryKind}. */
export const UNKNOWN_EMAIL_DELIVERY_KIND = 'unknown';

export type RecordedEmailKind = EmailDeliveryKind | typeof UNKNOWN_EMAIL_DELIVERY_KIND;

export interface EmailRelatedEntity {
  readonly type: string;
  readonly id: string;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Template name. Omitted sends are recorded as `unknown` (C35). */
  readonly kind?: EmailDeliveryKind;
  /** Alert or finding this message belongs to. Omitted for the test email. */
  readonly relatedEntity?: EmailRelatedEntity;
  /** Operation or request id of the process that attempted the send. */
  readonly correlationId?: string;
}

export type EmailSendResult =
  | { readonly kind: 'sent'; readonly providerMessageId: string | undefined }
  | {
      readonly kind: 'failed';
      readonly errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_PROVIDER_REJECTED';
      readonly reason: string;
    };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Email kind persisted while a transition awaits successful delivery.
 * Cleared only after the EmailSender reports `sent`, so a failed send is
 * retried on the next evaluation instead of being lost or duplicated.
 */
export type PendingAlertEmail = 'warning' | 'critical' | 'reminder' | 'recovery';

/** Maps the persist-then-send kind onto the delivery-log template name (C35). */
export function emailKindForPendingAlert(pendingEmail: PendingAlertEmail): EmailDeliveryKind {
  switch (pendingEmail) {
    case 'warning':
      return 'treasury_warning';
    case 'critical':
      return 'treasury_critical';
    case 'reminder':
      return 'treasury_unresolved_reminder';
    case 'recovery':
      return 'treasury_recovery';
    default: {
      const _exhaustive: never = pendingEmail;
      return _exhaustive;
    }
  }
}

export type EmailDeliveryStatus = 'sent' | 'failed';

/** One observed send attempt. The message body is not part of this record (C35). */
export interface StoredEmailDelivery {
  readonly id: string;
  readonly sentAt: Date;
  readonly kind: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly status: EmailDeliveryStatus;
  readonly providerMessageId: string | undefined;
  readonly errorCode: string | undefined;
  readonly errorSummary: string | undefined;
  readonly relatedEntityType: string | undefined;
  readonly relatedEntityId: string | undefined;
  readonly correlationId: string | undefined;
  readonly serviceRole: string;
  readonly createdAt: Date;
}

export interface RecordEmailDeliveryInput {
  readonly sentAt: Date;
  readonly kind: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly status: EmailDeliveryStatus;
  readonly providerMessageId: string | undefined;
  readonly errorCode: string | undefined;
  readonly errorSummary: string | undefined;
  readonly relatedEntityType: string | undefined;
  readonly relatedEntityId: string | undefined;
  readonly correlationId: string | undefined;
  readonly serviceRole: string;
}

export interface EmailDeliveryListFilters {
  readonly limit: number;
  readonly offset: number;
  readonly status?: EmailDeliveryStatus;
  readonly kind?: string;
}

export interface EmailDeliveryListPage {
  readonly items: readonly StoredEmailDelivery[];
  readonly total: number;
}

/**
 * Observation of what an email send did. Not part of the alert transaction:
 * a failure here must not change the sender's result (C35).
 */
export interface EmailDeliveryRepository {
  record(input: RecordEmailDeliveryInput): Promise<void>;
  list(filters: EmailDeliveryListFilters): Promise<EmailDeliveryListPage>;
}

/** Open treasury (or other entity) alert row. Resolved alerts are not returned. */
export interface StoredOpenAlert {
  readonly id: string;
  readonly alertType: string;
  readonly severity: AlertSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly firstTriggeredAt: Date;
  readonly lastEvaluatedAt: Date;
  /** Undefined until the opening/escalation/reminder email is acknowledged. */
  readonly lastSentAt: Date | undefined;
  readonly pendingEmail: PendingAlertEmail | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InsertOpenAlertInput {
  readonly alertType: string;
  readonly severity: AlertSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly firstTriggeredAt: Date;
  readonly lastEvaluatedAt: Date;
  readonly pendingEmail: PendingAlertEmail;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Persisted alert lifecycle states. `acknowledged` is distinct from `resolved` (C20). */
export type AlertLifecycleState = 'open' | 'resolved' | 'acknowledged';

/**
 * Full alert row for list/acknowledge reads (C20). Includes terminal states —
 * unlike {@link StoredOpenAlert}, which is the open-row mutation view.
 */
export interface StoredAlert {
  readonly id: string;
  readonly alertType: string;
  readonly severity: AlertSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly state: AlertLifecycleState;
  readonly firstTriggeredAt: Date;
  readonly lastEvaluatedAt: Date;
  readonly lastSentAt: Date | undefined;
  readonly resolvedAt: Date | undefined;
  readonly acknowledgedAt: Date | undefined;
  readonly acknowledgedBy: string | undefined;
  readonly acknowledgementNote: string | undefined;
  readonly pendingEmail: PendingAlertEmail | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AlertListFilters {
  readonly limit: number;
  readonly offset: number;
  readonly alertType?: string;
  readonly state?: AlertLifecycleState;
  readonly entityType?: string;
}

export interface AlertListPage {
  readonly items: readonly StoredAlert[];
  readonly total: number;
}

/**
 * Append-oriented alert persistence (AGENTS.md §9).
 *
 * Resolve by setting `state`/`resolved_at` — never delete. Email-worthy
 * transitions are persisted with `pendingEmail` and without advancing
 * `last_sent_at` until {@link AlertRepository.acknowledgeSend} after a
 * successful send.
 *
 * Operator acknowledgement of a finding alert is a distinct terminal state
 * (`acknowledged`) via {@link AlertRepository.recordOperatorAcknowledgement} —
 * never overload {@link AlertRepository.acknowledgeSend}.
 */
export interface AlertRepository {
  findOpenByEntity(
    entityType: string,
    entityId: string,
    alertType: string,
  ): Promise<StoredOpenAlert | undefined>;
  /**
   * Dedupe lookup for finding alerts (C18/C20): matches `open` **or**
   * `acknowledged`. Resolved rows are excluded. When both states exist for the
   * same entityId (condition recurrence after ack), **open is preferred** —
   * ordering is explicit, not "newest firstTriggeredAt wins".
   */
  findOpenOrAcknowledgedByEntity(
    entityType: string,
    entityId: string,
    alertType: string,
  ): Promise<StoredAlert | undefined>;
  findById(id: string): Promise<StoredAlert | undefined>;
  list(filters: AlertListFilters): Promise<AlertListPage>;
  /**
   * Inserts an open alert. Concurrent inserts racing the partial unique index
   * on `(entity_type, entity_id, alert_type) WHERE state = 'open'` (TX.19)
   * throw a unique violation — callers must catch via `isUniqueViolation`,
   * re-read with the path's lookup (`findOpenByEntity` or
   * `findOpenOrAcknowledgedByEntity`), and adopt the winner as deduped.
   * Swallowing the race as an unhandled throw loses the alert (C18).
   */
  insertOpen(input: InsertOpenAlertInput): Promise<StoredOpenAlert>;
  /** warning → critical; leaves last_sent_at unchanged. */
  markEscalated(input: {
    readonly id: string;
    readonly lastEvaluatedAt: Date;
    readonly pendingEmail: PendingAlertEmail;
  }): Promise<StoredOpenAlert>;
  /** Sets pendingEmail (remind/recovery) without advancing last_sent_at. */
  markPendingEmail(input: {
    readonly id: string;
    readonly lastEvaluatedAt: Date;
    readonly pendingEmail: PendingAlertEmail;
    /** Merged into metadata_json; pendingEmail key is applied after the merge. */
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<StoredOpenAlert>;
  /** Clears a stale pendingEmail without advancing last_sent_at. */
  clearPendingEmail(input: { readonly id: string; readonly lastEvaluatedAt: Date }): Promise<StoredOpenAlert>;
  /** Advances last_sent_at and clears pendingEmail after a successful send. */
  acknowledgeSend(input: {
    readonly id: string;
    readonly lastSentAt: Date;
    readonly lastEvaluatedAt: Date;
  }): Promise<StoredOpenAlert>;
  /**
   * Records an operator acknowledgement (C20). Sets `state = 'acknowledged'` —
   * never `resolved`. Distinct from {@link acknowledgeSend}.
   */
  recordOperatorAcknowledgement(input: {
    readonly id: string;
    readonly acknowledgedAt: Date;
    readonly acknowledgedBy: string;
    readonly acknowledgementNote: string;
    readonly lastEvaluatedAt: Date;
  }): Promise<StoredAlert>;
  /** Marks the alert resolved; never deletes the row. */
  resolve(input: {
    readonly id: string;
    readonly resolvedAt: Date;
    readonly lastEvaluatedAt: Date;
  }): Promise<StoredOpenAlert>;
  touchLastEvaluated(input: {
    readonly id: string;
    readonly lastEvaluatedAt: Date;
    /** When set, merged into metadata_json (pendingEmail key preserved). */
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

/** Project summary used when registering or listing managed wallets. */
export interface ProjectSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** Full project record returned by project management APIs. */
export interface Project extends ProjectSummary {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Environment summary used when registering or listing managed wallets. */
export interface EnvironmentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** Full environment record returned by project management APIs. */
export interface Environment extends EnvironmentSummary {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectInsert {
  readonly slug: string;
  readonly name: string;
}

export interface EnvironmentInsert {
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
}

export interface ProjectListPage {
  readonly items: readonly Project[];
  readonly total: number;
}

export interface EnvironmentListPage {
  readonly items: readonly Environment[];
  readonly total: number;
}

/** One row from api_credential_scopes. Null environmentId = all environments in the project. */
export interface CredentialScope {
  readonly id: string;
  readonly credentialId: string;
  readonly projectId: string;
  readonly environmentId: string | undefined;
  readonly createdAt: Date;
}

export interface CredentialScopeInsert {
  readonly credentialId: string;
  readonly projectId: string;
  readonly environmentId: string | undefined;
}

export interface ProjectRepository {
  insert(input: ProjectInsert): Promise<Project>;
  findById(id: string): Promise<Project | undefined>;
  findBySlug(slug: string): Promise<Project | undefined>;
  list(pagination: { readonly limit: number; readonly offset: number }): Promise<ProjectListPage>;
  listByIds(ids: readonly string[]): Promise<readonly Project[]>;
  setEnabled(id: string, enabled: boolean): Promise<Project>;
}

export interface EnvironmentRepository {
  insert(input: EnvironmentInsert): Promise<Environment>;
  findById(id: string): Promise<Environment | undefined>;
  listByProject(
    projectId: string,
    pagination: { readonly limit: number; readonly offset: number },
  ): Promise<EnvironmentListPage>;
  setEnabled(id: string, enabled: boolean): Promise<Environment>;
}

export interface CredentialScopeRepository {
  listByCredentialId(credentialId: string): Promise<readonly CredentialScope[]>;
  insert(input: CredentialScopeInsert): Promise<CredentialScope>;
}

/** Persisted funding policy for one managed wallet (versioned). */
export interface StoredFundingPolicy {
  readonly id: string;
  readonly managedWalletId: string;
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Managed recipient wallet. Never holds private-key material — only a public
 * address on an allowlisted chain under a project/environment.
 */
export interface ManagedWallet {
  readonly id: string;
  readonly project: ProjectSummary;
  readonly environment: EnvironmentSummary;
  readonly chain: ChainDescriptor;
  /** Application role label (e.g. signer, relayer); not an API credential role. */
  readonly role: string;
  /** Lowercase normalized address used for uniqueness and lookups. */
  readonly address: string;
  /** EIP-55 checksummed address for display and explorer links. */
  readonly addressDisplay: string;
  readonly enabled: boolean;
  readonly criticalAtStartup: boolean;
  readonly reconciliationEnabled: boolean;
  readonly policy: StoredFundingPolicy | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ManagedWalletInsert {
  readonly environmentId: string;
  readonly chainRowId: string;
  readonly role: string;
  readonly address: string;
  readonly criticalAtStartup: boolean;
  readonly reconciliationEnabled: boolean;
}

export interface ManagedWalletListFilter {
  readonly projectId: string | undefined;
  readonly environmentId: string | undefined;
  readonly enabled: boolean | undefined;
}

export interface ManagedWalletListPage {
  readonly items: readonly ManagedWallet[];
  readonly total: number;
}

export interface ManagedWalletPatch {
  readonly enabled: boolean | undefined;
  readonly criticalAtStartup: boolean | undefined;
  readonly reconciliationEnabled: boolean | undefined;
}

export interface FundingPolicyUpsertInput {
  readonly managedWalletId: string;
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
}

export interface ManagedWalletRepository {
  insert(input: ManagedWalletInsert): Promise<ManagedWallet>;
  findById(id: string): Promise<ManagedWallet | undefined>;
  list(
    filter: ManagedWalletListFilter,
    pagination: { readonly limit: number; readonly offset: number },
  ): Promise<ManagedWalletListPage>;
  update(id: string, patch: ManagedWalletPatch): Promise<ManagedWallet>;
}

export interface FundingPolicyRepository {
  upsert(input: FundingPolicyUpsertInput): Promise<StoredFundingPolicy>;
  findByManagedWalletId(managedWalletId: string): Promise<StoredFundingPolicy | undefined>;
}

/** Durable funding request (idempotency + lifecycle). Contract C4 statuses. */
export interface FundingOperation {
  readonly id: string;
  readonly operationType: string;
  readonly projectId: string | undefined;
  readonly environmentId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly status: FundingOperationStatus;
  readonly requestedBy: string;
  readonly startedAt: Date;
  readonly completedAt: Date | undefined;
  readonly errorCode: string | undefined;
  readonly errorSummary: string | undefined;
}

/** On-chain funding transfer record. Contract C4 statuses. */
export interface FundingTransaction {
  readonly id: string;
  readonly operationId: string;
  readonly treasuryId: string;
  readonly managedWalletId: string | undefined;
  readonly destinationTreasuryId: string | undefined;
  readonly amountWei: bigint;
  readonly transactionHash: string | undefined;
  readonly nonce: number | undefined;
  readonly status: FundingTransactionStatus;
  readonly errorCode: string | undefined;
  readonly createdAt: Date;
  readonly submittedAt: Date | undefined;
  readonly confirmedAt: Date | undefined;
}

export interface FundingTransactionListFilter {
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly managedWalletId?: string;
  readonly status?: FundingTransactionStatus;
  readonly operationType?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

/** One row in api_credential_scopes translated for history filtering. */
export interface FundingTransactionScopeClause {
  readonly projectId: string;
  readonly environmentId?: string;
}

export interface FundingTransactionScopeFilter {
  readonly kind: 'unrestricted' | 'scoped';
  readonly clauses?: readonly FundingTransactionScopeClause[];
}

/** Funding transaction with joined operation, wallet, project, environment, and chain. */
export interface FundingTransactionHistoryItem {
  readonly id: string;
  readonly operationId: string;
  readonly amountWei: bigint;
  readonly transactionHash: string | undefined;
  readonly nonce: number | undefined;
  readonly status: FundingTransactionStatus;
  readonly errorCode: string | undefined;
  readonly createdAt: Date;
  readonly submittedAt: Date | undefined;
  readonly confirmedAt: Date | undefined;
  readonly operation: {
    readonly id: string;
    readonly operationType: string;
    readonly status: FundingOperationStatus;
    readonly requestedBy: string;
    readonly startedAt: Date;
    readonly completedAt: Date | undefined;
  };
  readonly wallet:
    | {
        readonly id: string;
        readonly role: string;
        readonly address: string;
        readonly addressDisplay: string;
      }
    | undefined;
  readonly destinationTreasury:
    | {
        readonly id: string;
        readonly kind: TreasuryKind;
        readonly address: string;
        readonly addressDisplay: string;
      }
    | undefined;
  readonly project: ProjectSummary | undefined;
  readonly environment: EnvironmentSummary | undefined;
  readonly chain: ChainDescriptor;
}

export interface FundingTransactionListPage {
  readonly items: readonly FundingTransactionHistoryItem[];
  readonly total: number;
}

export interface InsertFundingOperationInput {
  readonly id: string;
  readonly operationType: string;
  readonly projectId: string | undefined;
  readonly environmentId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly requestedBy: string;
  readonly startedAt: Date;
}

export interface InsertFundingTransactionInput {
  readonly id: string;
  readonly operationId: string;
  readonly treasuryId: string;
  readonly managedWalletId: string | undefined;
  readonly destinationTreasuryId: string | undefined;
  readonly amountWei: bigint;
  readonly createdAt: Date;
}

/**
 * Durable pre-broadcast intent (TX.10 / C7). Committed outside the advisory-lock
 * transaction so a killed lock-holder still leaves a non-terminal gate row.
 */
export interface InsertBroadcastIntentInput {
  readonly id: string;
  readonly operationId: string;
  readonly treasuryId: string;
  readonly managedWalletId: string | undefined;
  readonly destinationTreasuryId: string | undefined;
  readonly amountWei: bigint;
  readonly nonce: number;
  readonly createdAt: Date;
}

export interface FundingOperationRepository {
  findById(id: string): Promise<FundingOperation | undefined>;
  findByIdempotencyKey(requestedBy: string, idempotencyKey: string): Promise<FundingOperation | undefined>;
  /** Inserts a pending row. Unique-violation races surface as Postgres 23505. */
  insertPending(input: InsertFundingOperationInput): Promise<FundingOperation>;
  markInProgress(id: string): Promise<FundingOperation>;
  markSucceeded(id: string, completedAt: Date): Promise<FundingOperation>;
  markFailed(
    id: string,
    errorCode: string,
    errorSummary: string,
    completedAt: Date,
  ): Promise<FundingOperation>;
  markAbandoned(
    id: string,
    errorCode: string,
    errorSummary: string,
    completedAt: Date,
  ): Promise<FundingOperation>;
}

export interface FundingTransactionRepository {
  findById(id: string): Promise<FundingTransaction | undefined>;
  findByOperationId(operationId: string): Promise<FundingTransaction | undefined>;
  /**
   * Returns an in-flight (created|submitted) transaction for the wallet, if any.
   * Used to prevent duplicate top-ups (AGENTS.md §7.5).
   */
  findPendingByManagedWallet(managedWalletId: string): Promise<FundingTransaction | undefined>;
  findPendingByDestinationTreasury(destinationTreasuryId: string): Promise<FundingTransaction | undefined>;
  /**
   * Total wei committed to in-flight transfers for this treasury across all
   * wallets. Required for the reserve check: an on-chain balance read cannot
   * see this treasury's own submitted-but-unmined sends (AGENTS.md §7.4).
   */
  sumInFlightAmountWeiByTreasury(treasuryId: string): Promise<bigint>;
  insertCreated(input: InsertFundingTransactionInput): Promise<FundingTransaction>;
  /**
   * Inserts a non-terminal `submission_unknown` row with the reserved nonce
   * *before* broadcast (TX.10). Must be called on a connection that commits
   * independently of the advisory-lock unit of work.
   */
  insertBroadcastIntent(input: InsertBroadcastIntentInput): Promise<FundingTransaction>;
  markSubmitted(
    id: string,
    input: { readonly transactionHash: string; readonly nonce: number; readonly submittedAt: Date },
  ): Promise<FundingTransaction>;
  /**
   * Records a submission whose outcome the node never confirmed. Non-terminal:
   * the transfer may still mine, so the duplicate-funding gate stays closed.
   */
  markSubmissionUnknown(
    id: string,
    input: { readonly nonce: number; readonly errorCode: string },
  ): Promise<FundingTransaction>;
  markConfirmed(id: string, confirmedAt: Date): Promise<FundingTransaction>;
  markReverted(id: string, errorCode: string): Promise<FundingTransaction>;
  markReplaced(id: string, errorCode: string): Promise<FundingTransaction>;
  markDropped(id: string, errorCode: string): Promise<FundingTransaction>;
  markFailed(id: string, errorCode: string): Promise<FundingTransaction>;
  list(
    filter: FundingTransactionListFilter & { readonly scope: FundingTransactionScopeFilter },
    pagination: { readonly limit: number; readonly offset: number },
  ): Promise<FundingTransactionListPage>;
}

/**
 * Serializes funding dispatch for one treasury/chain via pg_advisory_xact_lock (D7).
 * Repository methods on the unit of work share that transaction connection.
 */
export interface FundingDispatchLock {
  runExclusive<T>(
    treasuryId: string,
    evmChainId: number,
    work: (uow: FundingDispatchUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export interface FundingDispatchUnitOfWork {
  readonly operations: FundingOperationRepository;
  readonly transactions: FundingTransactionRepository;
}

/**
 * Runs an operator-facing database mutation and its audit entry in one
 * transaction (C21). Repository methods on the unit of work share that
 * connection — either both commit or neither does.
 *
 * Constructed from the pool-backed Database only. Nested `run` calls open an
 * independent transaction on another pooled connection; they do not join an
 * ambient transaction (including FundingDispatchLock). None of the C21 call
 * sites are reachable from inside funding dispatch.
 */
export interface OperatorMutationTransaction {
  run<T>(work: (uow: OperatorMutationUnitOfWork) => Promise<T>): Promise<T>;
}

export interface OperatorMutationUnitOfWork {
  readonly alerts: AlertRepository;
  readonly auditEvents: AuditEventRepository;
  readonly apiCredentials: ApiCredentialRepository;
  readonly treasuries: TreasuryRepository;
  readonly balanceObservations: BalanceObservationRepository;
  readonly managedWallets: ManagedWalletRepository;
  readonly fundingPolicies: FundingPolicyRepository;
  readonly projects: ProjectRepository;
  readonly environments: EnvironmentRepository;
  readonly chains: ChainRepository;
  readonly dashboardUsers: DashboardUserRepository;
  readonly dashboardSessions: DashboardSessionRepository;
}

/**
 * Waits for an on-chain receipt. Submission success must never be treated as
 * confirmation — callers persist `submitted` first, then invoke this.
 */
export type TransactionTrackingOutcome =
  | { readonly kind: 'confirmed'; readonly confirmedAt: Date }
  | { readonly kind: 'reverted' }
  | { readonly kind: 'replaced' }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'pending' };

export interface TransactionReceiptTracker {
  waitForOutcome(input: {
    readonly transactionHash: string;
    readonly confirmations: number;
    readonly timeoutMs: number;
    /**
     * Sender and nonce of the submitted transfer. Used as positive evidence
     * when the receipt wait fails: only a consumed nonce with an unknown hash
     * proves the transfer can never mine. Without such proof the outcome is
     * `pending` — a transient RPC error must never become a terminal state.
     */
    readonly senderAddress: string;
    readonly nonce: number;
  }): Promise<TransactionTrackingOutcome>;
}

// ---------------------------------------------------------------------------
// Reconciliation ports (C14)
// ---------------------------------------------------------------------------

/** Native transfer observed on-chain from the treasury during an outgoing scan. */
export interface TreasuryOutgoingTransfer {
  readonly transactionHash: string;
  readonly fromAddress: string;
  readonly toAddress: string | undefined;
  readonly valueWei: bigint;
  readonly nonce: number;
  readonly blockNumber: bigint;
}

export type OutgoingScanResult =
  | {
      readonly kind: 'ok';
      readonly transfers: readonly TreasuryOutgoingTransfer[];
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
    }
  | { readonly kind: 'incomplete'; readonly errorCode: string; readonly reason: string };

export type FindByNonceResult =
  | { readonly kind: 'found'; readonly transfer: TreasuryOutgoingTransfer }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'incomplete'; readonly errorCode: string; readonly reason: string };

export type ConfirmedNonceResult =
  | { readonly kind: 'ok'; readonly confirmedNonce: number }
  | { readonly kind: 'unavailable'; readonly errorCode: string; readonly reason: string };

export type LatestBlockNumberResult =
  | { readonly kind: 'ok'; readonly blockNumber: bigint }
  | { readonly kind: 'unavailable'; readonly errorCode: string; readonly reason: string };

/**
 * Public-client scan of treasury outgoing native transfers (C14).
 * Fail closed: RPC failure yields incomplete / unavailable, never an empty
 * "clean" report that could hide crash-orphans or key compromise.
 */
export interface TreasuryOutgoingScanner {
  getConfirmedTransactionCount(address: string): Promise<ConfirmedNonceResult>;
  getLatestBlockNumber(): Promise<LatestBlockNumberResult>;
  /**
   * Confirmed transaction count at a specific block (TX.9 bisect for nonce hunt).
   * Same semantics as `eth_getTransactionCount(address, blockNumber)`.
   */
  getTransactionCountAtBlock(input: {
    readonly address: string;
    readonly blockNumber: bigint;
  }): Promise<ConfirmedNonceResult>;
  findOutgoingByNonce(input: {
    readonly fromAddress: string;
    readonly nonce: number;
    readonly lookbackBlocks: bigint;
  }): Promise<FindByNonceResult>;
  /**
   * Scan inclusive `[fromBlock, toBlock]` for native value transfers from the
   * treasury. Callers compute the window (incremental watermark + per-run cap).
   */
  listOutgoingTransfers(input: {
    readonly fromAddress: string;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<OutgoingScanResult>;
}

/** Persisted reconciliation run summary (P4-US1). */
export interface ReconciliationRun {
  readonly id: string;
  readonly runId: string;
  readonly requestedBy: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | undefined;
  readonly walletsAssessed: number;
  readonly walletsFunded: number;
  readonly walletsNoop: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
  readonly weiTransferred: bigint;
  readonly submissionUnknownResolved: number;
  readonly submissionUnknownLeftPending: number;
  readonly unexplainedTransferCount: number;
  readonly outgoingScanStatus: 'complete' | 'incomplete' | 'not-run';
  readonly findings: readonly ReconciliationFinding[];
  readonly errorCode: string | undefined;
  readonly errorSummary: string | undefined;
}

export type ReconciliationFinding =
  | {
      readonly kind: 'unexplained_outgoing_transfer';
      readonly severity: 'critical';
      readonly treasuryId: string;
      readonly transactionHash: string;
      readonly toAddress: string | undefined;
      readonly valueWei: string;
      readonly nonce: number;
      readonly blockNumber: string;
    }
  | {
      readonly kind: 'outgoing_scan_incomplete';
      readonly severity: 'critical';
      readonly treasuryId: string;
      readonly errorCode: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'outgoing_scan_coverage_behind';
      readonly severity: 'warning';
      readonly treasuryId: string;
      /** Watermark before this run. */
      readonly lastScannedBlock: string;
      readonly scannedFromBlock: string;
      readonly scannedToBlock: string;
      readonly tip: string;
      /** Blocks still outstanding after this run (`tip - scannedToBlock`). */
      readonly blocksRemaining: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'submission_unknown_unresolved';
      readonly severity: 'warning';
      readonly treasuryId: string;
      readonly transactionId: string;
      readonly nonce: number | undefined;
      readonly reason: string;
    }
  | {
      readonly kind: 'wallet_assessment_failed';
      readonly severity: 'warning';
      readonly walletId: string;
      readonly reason: string;
    }
  | {
      /**
       * One configured chain's outcome for this run (C29). Persisted in
       * `findings_json` so a later C15 streak recount can see it. `chainId` is
       * the EVM chain id, not the `chains` row uuid. Warning severity: a
       * healthy chain must not open a C18 critical alert.
       */
      readonly kind: 'chain_outcome';
      readonly severity: 'warning';
      readonly chainId: number;
      readonly status: 'processed' | 'processed-with-failures' | 'unavailable';
      readonly errorCode: string | undefined;
      readonly reason: string | undefined;
    };

export interface InsertReconciliationRunInput {
  readonly id: string;
  readonly runId: string;
  readonly requestedBy: string;
  readonly startedAt: Date;
}

export interface FinishReconciliationRunInput {
  readonly id: string;
  readonly finishedAt: Date;
  readonly walletsAssessed: number;
  readonly walletsFunded: number;
  readonly walletsNoop: number;
  readonly walletsBlocked: number;
  readonly walletsFailed: number;
  readonly weiTransferred: bigint;
  readonly submissionUnknownResolved: number;
  readonly submissionUnknownLeftPending: number;
  readonly unexplainedTransferCount: number;
  readonly outgoingScanStatus: 'complete' | 'incomplete' | 'not-run';
  readonly findings: readonly ReconciliationFinding[];
  readonly errorCode: string | undefined;
  readonly errorSummary: string | undefined;
}

export interface ReconciliationRunListPage {
  readonly items: readonly ReconciliationRun[];
  readonly total: number;
}

export interface ReconciliationRunRepository {
  insertStarted(input: InsertReconciliationRunInput): Promise<ReconciliationRun>;
  markFinished(input: FinishReconciliationRunInput): Promise<ReconciliationRun>;
  findById(id: string): Promise<ReconciliationRun | undefined>;
  /**
   * Recent runs newest-first by `started_at` (C15). Used to derive consecutive
   * failure counts without a separate counter column.
   */
  listRecent(limit: number): Promise<readonly ReconciliationRun[]>;
  /**
   * Newest run that actually finished (`finished_at IS NOT NULL`), ordered by
   * `finished_at` descending. Aborted crash rows (finished_at null) never win,
   * even when `outgoing_scan_status` looks complete — funding health freshness
   * depends on this distinction.
   */
  findLatestFinished(): Promise<ReconciliationRun | undefined>;
  /**
   * Paginated runs newest-first by `started_at` (C19). `total` is the true
   * matching count, not the page length.
   */
  list(pagination: { readonly limit: number; readonly offset: number }): Promise<ReconciliationRunListPage>;
  /** True count of all reconciliation runs (C19 pagination). */
  count(): Promise<number>;
}

/** Last successful on-chain fund recorded for a managed wallet. */
export interface WalletLastFundedRecord {
  readonly managedWalletId: string;
  readonly fundedAt: Date;
  readonly amountWei: bigint;
  readonly transactionHash: string;
}

/**
 * Latest reconciler funding attempt for a managed wallet (may be blocked /
 * failed without a transaction row — linked via reconcile idempotency key).
 */
export interface WalletFundingAttemptRecord {
  readonly managedWalletId: string;
  readonly attemptedAt: Date;
  readonly outcome: 'blocked' | 'failed' | 'succeeded' | 'pending';
  readonly errorCode: string | undefined;
  readonly amountWei: bigint | undefined;
  readonly transactionHash: string | undefined;
}

/**
 * Read-side queries for GET /health/funding. Kept separate from dispatch-owned
 * funding repositories so observability does not widen the signing surface.
 */
export interface FundingHealthQuery {
  findLatestFundedByWalletIds(
    managedWalletIds: readonly string[],
  ): Promise<readonly WalletLastFundedRecord[]>;
  findLatestReconcileAttemptsSince(
    managedWalletIds: readonly string[],
    since: Date,
  ): Promise<readonly WalletFundingAttemptRecord[]>;
}

/**
 * Read-side queries over funding_transactions that reconciliation needs.
 * Kept separate from FundingTransactionRepository so T4.1 does not edit the
 * dispatch-owned repository adapter (TX.8 / file-scope rules).
 */
export interface ReconciliationFundingQuery {
  listSubmissionUnknownByTreasury(treasuryId: string): Promise<readonly FundingTransaction[]>;
  /** Lowercase hashes recorded for this treasury (any status with a hash). */
  listRecordedTransactionHashesByTreasury(treasuryId: string): Promise<readonly string[]>;
}
