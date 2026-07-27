import { relations } from 'drizzle-orm';
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
 * Phase 0 schema: chains, treasuries, balance observations, audit events,
 * API credentials, and cross-process heartbeats.
 *
 * Tables for projects, environments, managed wallets, funding policies, and
 * funding transactions arrive with the phases that implement them, so that no
 * unused table implies a capability the service does not have.
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

export const chainsRelations = relations(chains, ({ many }) => ({
  treasuries: many(treasuries),
  balanceObservations: many(balanceObservations),
}));

export const treasuriesRelations = relations(treasuries, ({ one }) => ({
  chain: one(chains, { fields: [treasuries.chainId], references: [chains.id] }),
}));

export const balanceObservationsRelations = relations(balanceObservations, ({ one }) => ({
  chain: one(chains, { fields: [balanceObservations.chainId], references: [chains.id] }),
}));

export type ChainRow = typeof chains.$inferSelect;
export type TreasuryRow = typeof treasuries.$inferSelect;
export type BalanceObservationRow = typeof balanceObservations.$inferSelect;
export type ApiCredentialRow = typeof apiCredentials.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ServiceHeartbeatRow = typeof serviceHeartbeats.$inferSelect;
