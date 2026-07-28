import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 0–3 schema: chains, treasuries, balance observations, audit events,
 * API credentials, cross-process heartbeats, plus projects, environments,
 * managed wallets, funding policies, funding operations/transactions, and alerts.
 */

/** All wei-denominated columns use this precision. Never widen it silently. */
const weiColumn = (name: string) => numeric(name, { precision: 78, scale: 0 });

export const treasuryStatusEnum = pgEnum('treasury_status', ['healthy', 'warning', 'critical', 'unknown']);

export const walletTypeEnum = pgEnum('wallet_type', ['treasury', 'managed_wallet']);

export const apiRoleEnum = pgEnum('api_role', [
  'operator',
  'project-service',
  'read-only',
  'cron-treasury-monitor',
  'cron-reconciler',
]);

export const actorTypeEnum = pgEnum('actor_type', ['api_credential', 'cron', 'system']);

/** Contract C4 — funding_operations.status */
export const fundingOperationStatusEnum = pgEnum('funding_operation_status', [
  'pending',
  'in_progress',
  'succeeded',
  'failed',
  'abandoned',
]);

/** Contract C4 — funding_transactions.status */
export const fundingTransactionStatusEnum = pgEnum('funding_transaction_status', [
  'created',
  'submitted',
  'confirmed',
  'reverted',
  'replaced',
  'dropped',
  'failed',
]);

export const chains = pgTable(
  'chains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    chainId: integer('chain_id').notNull(),
    displayName: text('display_name').notNull(),
    nativeSymbol: text('native_symbol').notNull(),
    explorerBaseUrl: text('explorer_base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('chains_slug_key').on(table.slug),
    uniqueIndex('chains_chain_id_key').on(table.chainId),
  ],
);

export const treasuries = pgTable(
  'treasuries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => chains.id, { onDelete: 'restrict' }),
    /** Lowercase form. This is the uniqueness and lookup key. */
    address: text('address').notNull(),
    /** EIP-55 checksummed form, for display and explorer links. */
    addressDisplay: text('address_display').notNull(),

    warningBalanceWei: weiColumn('warning_balance_wei').notNull(),
    criticalBalanceWei: weiColumn('critical_balance_wei').notNull(),
    recoveryBalanceWei: weiColumn('recovery_balance_wei').notNull(),
    minimumReserveWei: weiColumn('minimum_reserve_wei').notNull(),

    status: treasuryStatusEnum('status').notNull().default('unknown'),
    /** Last successful read. Stays untouched when a read fails. */
    lastObservedBalanceWei: weiColumn('last_observed_balance_wei'),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    /** Last attempt, successful or not. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Populated only when the most recent attempt failed. */
    lastCheckErrorCode: text('last_check_error_code'),

    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('treasuries_chain_address_key').on(table.chainId, table.address)],
);

/**
 * Append-only ledger of on-chain readings. A failed RPC call produces no row,
 * so the absence of an observation is never mistaken for a zero balance.
 */
export const balanceObservations = pgTable(
  'balance_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => chains.id, { onDelete: 'restrict' }),
    walletAddress: text('wallet_address').notNull(),
    walletType: walletTypeEnum('wallet_type').notNull(),
    balanceWei: weiColumn('balance_wei').notNull(),
    blockNumber: weiColumn('block_number').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    /** Correlation ID of the request or cron run that produced the reading. */
    sourceOperationId: text('source_operation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('balance_observations_lookup_idx').on(table.chainId, table.walletAddress, table.observedAt),
  ],
);

export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Operator-facing label. Never the token itself. */
    name: text('name').notNull(),
    role: apiRoleEnum('role').notNull(),
    /**
     * SHA-256 of the presented token. Tokens are 256-bit random values, so a
     * fast hash is appropriate: there is no low-entropy input to brute force.
     */
    tokenHash: text('token_hash').notNull(),
    /** Leading characters of the token, for identifying it in logs and the UI. */
    tokenPrefix: text('token_prefix').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_credentials_token_hash_key').on(table.tokenHash),
    uniqueIndex('api_credentials_name_key').on(table.name),
  ],
);

/** Append-oriented. Rows are never updated or deleted. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    requestId: text('request_id'),
    sourceIp: text('source_ip'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_created_at_idx').on(table.createdAt)],
);

/**
 * One row per process role, upserted on startup and on each cron run.
 *
 * This is the health-check row required by Phase 0: the web service and the
 * cron job each write their own row and read the other's, demonstrating that
 * both are bound to the same database.
 */
export const serviceHeartbeats = pgTable('service_heartbeats', {
  serviceRole: text('service_role').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  /** Correlation ID of the run or boot that wrote this row. */
  lastOperationId: text('last_operation_id'),
  detail: jsonb('detail').notNull().default({}),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('projects_slug_key').on(table.slug)],
);

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('environments_project_slug_key').on(table.projectId, table.slug)],
);

export const managedWallets = pgTable(
  'managed_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'restrict' }),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => chains.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    /** Lowercase form. This is the uniqueness and lookup key. */
    address: text('address').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    criticalAtStartup: boolean('critical_at_startup').notNull().default(false),
    reconciliationEnabled: boolean('reconciliation_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('managed_wallets_chain_address_key').on(table.chainId, table.address)],
);

export const fundingPolicies = pgTable(
  'funding_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    managedWalletId: uuid('managed_wallet_id')
      .notNull()
      .references(() => managedWallets.id, { onDelete: 'restrict' }),
    minimumBalanceWei: weiColumn('minimum_balance_wei').notNull(),
    targetBalanceWei: weiColumn('target_balance_wei').notNull(),
    maximumTopUpWei: weiColumn('maximum_top_up_wei').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('funding_policies_managed_wallet_id_key').on(table.managedWalletId)],
);

export const fundingOperations = pgTable(
  'funding_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationType: text('operation_type').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    status: fundingOperationStatusEnum('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
  },
  (table) => [
    uniqueIndex('funding_operations_requested_by_idempotency_key')
      .on(table.requestedBy, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const fundingTransactions = pgTable('funding_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  operationId: uuid('operation_id')
    .notNull()
    .references(() => fundingOperations.id, { onDelete: 'restrict' }),
  treasuryId: uuid('treasury_id')
    .notNull()
    .references(() => treasuries.id, { onDelete: 'restrict' }),
  managedWalletId: uuid('managed_wallet_id')
    .notNull()
    .references(() => managedWallets.id, { onDelete: 'restrict' }),
  amountWei: weiColumn('amount_wei').notNull(),
  transactionHash: text('transaction_hash'),
  nonce: integer('nonce'),
  status: fundingTransactionStatusEnum('status').notNull().default('created'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertType: text('alert_type').notNull(),
  severity: text('severity').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  state: text('state').notNull(),
  firstTriggeredAt: timestamp('first_triggered_at', { withTimezone: true }).notNull(),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }).notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  metadataJson: jsonb('metadata_json').notNull().default({}),
});

export const chainsRelations = relations(chains, ({ many }) => ({
  treasuries: many(treasuries),
  balanceObservations: many(balanceObservations),
  managedWallets: many(managedWallets),
}));

export const treasuriesRelations = relations(treasuries, ({ one, many }) => ({
  chain: one(chains, { fields: [treasuries.chainId], references: [chains.id] }),
  fundingTransactions: many(fundingTransactions),
}));

export const balanceObservationsRelations = relations(balanceObservations, ({ one }) => ({
  chain: one(chains, { fields: [balanceObservations.chainId], references: [chains.id] }),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
  fundingOperations: many(fundingOperations),
}));

export const environmentsRelations = relations(environments, ({ one, many }) => ({
  project: one(projects, { fields: [environments.projectId], references: [projects.id] }),
  managedWallets: many(managedWallets),
  fundingOperations: many(fundingOperations),
}));

export const managedWalletsRelations = relations(managedWallets, ({ one, many }) => ({
  environment: one(environments, {
    fields: [managedWallets.environmentId],
    references: [environments.id],
  }),
  chain: one(chains, { fields: [managedWallets.chainId], references: [chains.id] }),
  fundingPolicy: one(fundingPolicies),
  fundingTransactions: many(fundingTransactions),
}));

export const fundingPoliciesRelations = relations(fundingPolicies, ({ one }) => ({
  managedWallet: one(managedWallets, {
    fields: [fundingPolicies.managedWalletId],
    references: [managedWallets.id],
  }),
}));

export const fundingOperationsRelations = relations(fundingOperations, ({ one, many }) => ({
  project: one(projects, { fields: [fundingOperations.projectId], references: [projects.id] }),
  environment: one(environments, {
    fields: [fundingOperations.environmentId],
    references: [environments.id],
  }),
  fundingTransactions: many(fundingTransactions),
}));

export const fundingTransactionsRelations = relations(fundingTransactions, ({ one }) => ({
  operation: one(fundingOperations, {
    fields: [fundingTransactions.operationId],
    references: [fundingOperations.id],
  }),
  treasury: one(treasuries, {
    fields: [fundingTransactions.treasuryId],
    references: [treasuries.id],
  }),
  managedWallet: one(managedWallets, {
    fields: [fundingTransactions.managedWalletId],
    references: [managedWallets.id],
  }),
}));

export type ChainRow = typeof chains.$inferSelect;
export type TreasuryRow = typeof treasuries.$inferSelect;
export type BalanceObservationRow = typeof balanceObservations.$inferSelect;
export type ApiCredentialRow = typeof apiCredentials.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ServiceHeartbeatRow = typeof serviceHeartbeats.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type ManagedWalletRow = typeof managedWallets.$inferSelect;
export type FundingPolicyRow = typeof fundingPolicies.$inferSelect;
export type FundingOperationRow = typeof fundingOperations.$inferSelect;
export type FundingTransactionRow = typeof fundingTransactions.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
