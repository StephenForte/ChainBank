# ChainBank Shared Decisions Doc

Single source of truth for cross-task decisions. Workers: read this before starting;
if your task needs a PENDING decision, stop and flag it rather than guessing
(AGENTS.md §1.7). When you make a local design choice other tasks will depend on,
add it under "Interface contracts" in your PR.

Status values: **PENDING** (blocks dependent work), **DECIDED** (cite date + decider),
**SUPERSEDED** (link replacement).

---

## 1. Open product/architecture decisions

| #   | Question                                                                       | Status                | Decision                                                                                                                                                                                                                                                                                                                                                                             | Date       | Decider                                  |
| --- | ------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------- |
| D1  | Signing key: Render secret env var for MVP, or external signer before Phase 1? | DECIDED (default)     | Render secret env (`TREASURY_PRIVATE_KEY`) behind the `TreasurySigner` interface; external signer is a later swap. Only signing-capable services receive the secret group.                                                                                                                                                                                                           | 2026-07-28 | planner (override if operator disagrees) |
| D2  | Dashboard auth: operator API tokens or identity provider?                      | DECIDED (default)     | Operator bearer tokens (existing hashed-credential system). No IdP in MVP.                                                                                                                                                                                                                                                                                                           | 2026-07-28 | planner                                  |
| D3  | Exact warning / critical / recovery / reserve balances for ForteL2             | DECIDED               | Warning 0.75 ETH, critical 0.3, recovery 1.5, reserve 0.1 — declared as literal `value:` entries in `render.yaml` (both services), not dashboard-set, so CI validates the ladder before it can reach a service. Ordering: reserve < critical ≤ warning ≤ recovery.                                                                                                                   | 2026-07-29 | operator                                 |
| D4  | Startup confirmation count on Sepolia                                          | DECIDED (default)     | 1 confirmation, configurable via `FUNDING_CONFIRMATIONS` (default 1), timeout `FUNDING_CONFIRMATION_TIMEOUT_MS` (default 60000). Timeout ⇒ `pending`, never failure.                                                                                                                                                                                                                 | 2026-07-28 | planner                                  |
| D5  | Local dev DB: SQLite locally or local Postgres?                                | DECIDED               | Local Postgres without Docker (Postgres.app / Homebrew) — already the Phase 0 convention. No SQLite path.                                                                                                                                                                                                                                                                            | 2026-07-28 | existing repo convention                 |
| D6  | E2E chain: Anvil, or mocked JSON-RPC only?                                     | DECIDED (provisional) | `anvil` (foundry), spawned only if present on `PATH` with the suite skipping otherwise. It is an external binary, not an npm package, so nothing enters the lockfile and AGENTS.md §14 is not engaged. Unit and integration suites keep using mocked JSON-RPC and Viem test accounts. Penciled in — reconfirm when T4.4 actually starts; if nothing has changed by then this stands. | 2026-07-29 | operator (provisional)                   |
| D7  | Reconciliation lock mechanism                                                  | DECIDED (default)     | Postgres advisory lock (`pg_advisory_xact_lock`) keyed by (treasury, chain) hash, plus a `funding_operations` row-level state machine for idempotency. No new dependency.                                                                                                                                                                                                            | 2026-07-28 | planner                                  |
| D8  | Rate limiting implementation                                                   | DECIDED (moot)        | `@fastify/rate-limit` was already a dependency from the Phase 0 bootstrap and is registered in `src/api/app.ts` alongside helmet and deny-by-default CORS. Raised as needing approval in error; no new dependency was ever introduced.                                                                                                                                               | 2026-07-29 | planner (correction)                     |
| D9  | CI secret-scan tooling                                                         | DECIDED (default)     | `gitleaks` official GitHub Action, pinned by commit SHA. A CI action, not an npm dependency; override if operator prefers another scanner.                                                                                                                                                                                                                                           | 2026-07-28 | planner                                  |
| D10 | Credential project/environment scoping storage                                 | DECIDED (default)     | New `api_credential_scopes` table (credential FK + project FK + nullable environment FK), migration `0002`, owned by T2.1. Null environment = all environments in that project. Non-scoped roles (operator, read-only, crons) ignore the table.                                                                                                                                      | 2026-07-28 | planner                                  |

## 2. Interface contracts (append-only; workers add entries)

Contracts other tasks compile against. Once published here, changing one requires
updating every consumer in the same PR or a coordinated pair of PRs.

### C1 — `TreasurySigner` port (owner: T1.4)

```ts
// src/app/ports.ts (extension)
interface TreasurySigner {
  /** Fails closed: throws SIGNER_UNAVAILABLE if key config is absent/malformed. */
  readonly address: string;
  sendNativeTransfer(input: {
    readonly to: string; // checksummed, pre-validated allowlisted address
    readonly valueWei: bigint;
    readonly nonce: number;
  }): Promise<{ readonly transactionHash: string }>;
  getTransactionCount(): Promise<number>;
  estimateTransferCostWei(to: string, valueWei: bigint): Promise<bigint>; // fails closed
  verifyChainId(): Promise<{ readonly matches: boolean; readonly observedChainId: number | undefined }>;
}
```

Local design choices (T1.4, 2026-07-28):

- Signing-capable roles: `web` and `cron-reconciler` (`isSigningCapableRole`).
  `treasury-monitor` always strips `TREASURY_PRIVATE_KEY` before parse and never
  constructs a signer.
- `FUNDING_KILL_SWITCH` gates `sendNativeTransfer` only (`FUNDING_DISABLED`);
  `verifyChainId` / `getTransactionCount` / `estimateTransferCostWei` remain available.
- Gas estimation failure throws `GAS_ESTIMATION_FAILED` (no fallback constant).
- Private key is stored non-enumerably on `config.funding`; use `getTreasuryPrivateKey`.

### C2 — Funding math domain functions (owner: T1.2)

```ts
// src/domain/funding/ — pure, bigint only, no I/O
interface FundingPolicy {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly isEnabled: boolean; // application-layer enable gate
}

interface FundingPolicyInput {
  readonly minimumBalanceWei: bigint;
  readonly targetBalanceWei: bigint;
  readonly maximumTopUpWei: bigint;
  readonly isEnabled: boolean;
}

type TopUpDecision =
  | { readonly kind: 'no-op'; readonly reason: 'at-or-above-minimum' }
  | { readonly kind: 'fund'; readonly amountWei: bigint }
  | { readonly kind: 'blocked'; readonly reason: 'reserve' | 'max-top-up-zero' | 'policy-disabled' };

type PolicyValidationResult =
  | { readonly ok: true; readonly policy: FundingPolicy }
  | {
      readonly ok: false;
      readonly code: 'INVALID_AMOUNT' | 'INVALID_CONFIGURATION';
      readonly message: string;
      readonly publicMessage: string;
    };

function validatePolicy(p: FundingPolicyInput): PolicyValidationResult;
// target >= minimum, maximumTopUp > 0, all amounts >= 0

function calculateTopUp(input: {
  readonly currentBalanceWei: bigint;
  readonly policy: FundingPolicy;
  readonly treasurySpendableWei: bigint; // balance - reserve - estimated cost
}): TopUpDecision;
// Precedence: at-or-above-minimum → policy-disabled → max-top-up-zero →
// fund min(deficit, maximumTopUp, spendable) → blocked reserve if amount is 0

function calculateTreasurySpendableWei(input: {
  readonly treasuryBalanceWei: bigint;
  readonly reserveWei: bigint;
  readonly estimatedCostWei: bigint;
}): bigint; // floors at 0n; rejects negatives
```

### C3 — Alert state machine (owner: T3.1)

```ts
// src/domain/alerts/ — pure
type AlertSeverity = 'warning' | 'critical';

interface OpenAlertState {
  readonly severity: AlertSeverity;
  readonly firstTriggeredAt: Date;
  readonly lastSentAt: Date;
}

type AlertTransition =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly severity: AlertSeverity }
  | { readonly kind: 'escalate' } // warning -> critical
  | { readonly kind: 'remind' } // unresolved past reminder interval
  | { readonly kind: 'resolve' }; // recovery threshold satisfied

function evaluateTreasuryAlert(input: {
  readonly balanceWei: bigint;
  readonly thresholds: TreasuryThresholds;
  readonly openAlert: OpenAlertState | undefined;
  readonly now: Date; // injected clock
  readonly reminderIntervalMs: number;
}): AlertTransition;

function applyAlertTransition(
  openAlert: OpenAlertState | undefined,
  transition: AlertTransition,
  now: Date,
): OpenAlertState | undefined;
```

Local design choices (T3.1, 2026-07-28):

- Reuses `TreasuryThresholds` / `assertValidTreasuryThresholds` (critical ≤ warning ≤ recovery).
  Invalid ordering throws `ChainBankError` `INVALID_CONFIGURATION`.
- Alert balance bands differ from `evaluateTreasuryStatus` by recovery hysteresis:
  `balance >= recovery` is recovered; then critical / warning; else intermediate
  (`warning < balance < recovery`) keeps an open alert without opening a new one.
- When recovery equals warning, recovery wins at the shared threshold (no open).
- Priority with an open alert: resolve → escalate → remind → none.
- Critical does not de-escalate until recovery; partial refill stays open.
- `applyAlertTransition` advances `lastSentAt` on open/escalate/remind; resolve → `undefined`.
- `reminderIntervalMs` must be finite and ≥ 0; negative/NaN → `INVALID_CONFIGURATION`.

### C3a — Treasury alert orchestration (owner: T3.3)

```ts
// src/app/alerts/evaluate-treasury-alerts.ts
function evaluateTreasuryAlerts(deps, input): Promise<EvaluateTreasuryAlertsResult>;
// deps: AlertRepository, EmailSender, AuditEventRepository, Clock
// After a successful balance observation only. Used by treasury-monitor cron
// and POST /v1/treasuries/:id/check.

// src/app/ports.ts — AlertRepository
findOpenByEntity(entityType, entityId, alertType) /
  insertOpen /
  markEscalated /
  markPendingEmail /
  clearPendingEmail /
  acknowledgeSend /
  resolve /
  touchLastEvaluated;
```

Local design choices (T3.3, 2026-07-29):

- Alert type string: `treasury_balance`; entity type: `treasury`.
- Persist-then-send: structural open/escalate/remind/resolve-intent is written
  with `metadata_json.pendingEmail` (`warning|critical|reminder|recovery`) and
  **without** advancing `last_sent_at`. `acknowledgeSend` / `resolve` run only
  after `EmailSender` returns `sent`. Failed sends leave pending set for retry.
- Resolve is append-oriented: `state='resolved'` + `resolved_at`; never delete.
- `ALERT_REMINDER_INTERVAL_HOURS` (default 24) → `config.alerts.reminderIntervalMs`
  for web and treasury-monitor. Monitor gains email config; still never receives
  `TREASURY_PRIVATE_KEY` (`isSigningCapableRole` / omit-before-parse unchanged).

TX.6 amendment (2026-07-30):

- `findOpenByEntity` filters on `alert_type` alongside `entity_type`, `entity_id`,
  and `state='open'`, so multiple alert types may coexist on one entity without
  colliding (P3-US2 exactly-once email; PRD §7.9). Other `AlertRepository`
  mutators address rows by `id` and were left unchanged.
- Behavior-preserving while only `treasury_balance` exists: every open row shares
  that type, so the added predicate cannot change which row current callers see.

### C9 — Credential admin (owner: TX.4)

```ts
// HTTP (operator only; enforced in application services)
// GET   /v1/admin/credentials?limit&offset
// PATCH /v1/admin/credentials/:id  body: { action: 'disable' | 'revoke' | 'enable' }

// Application ports (src/app/ports.ts) — ApiCredentialRepository extensions
findById(id) /
  list(pagination) /
  disable(id, at) /
  revoke(
    id,
    at,
  )(
    // Permissions (src/domain/auth/roles.ts)
    'credential:read',
  ); // operator only
('credential:write'); // operator only
```

Local design choices (TX.4, 2026-07-30):

- List returns `ApiCredentialSummary` (includes `tokenPrefix`; never `token_hash`).
- **Disable** sets `enabled = false` only. **Revoke** is terminal:
  `enabled = false` and `revoked_at = now()`. **Enable** (added 2026-07-30)
  reverses a disable and never clears `revoked_at` — attempting to enable a
  revoked credential returns `CREDENTIAL_REVOKED` (409). Revocation is the
  response to a suspected compromise, so the endpoint that removes a leaked
  token must not be able to restore it; issue a replacement instead. All three
  write audit events (`credential.disabled` / `credential.revoked` /
  `credential.enabled`) recording previous and next state.
- Mutations refuse when `credentialId === actorCredentialId`
  (`CREDENTIAL_SELF_MUTATION_DENIED`), covering enable as well as the
  destructive actions. Authentication rejects disabled and revoked credentials
  alike, so self-mutation would lock the operator out with no in-product way
  back. **This makes a second operator credential an operational prerequisite**,
  now set up at deploy time (`docs/runbooks/deploy-render-phase0.md` step 4) and
  stated in the runbook index.
- Revoke/disable do not delete `api_credential_scopes` rows or audit history.

### C10 — Treasury reserve-exhaustion alert (owner: T1.8)

```ts
// src/app/alerts/notify-treasury-reserve-alert.ts
export const TREASURY_RESERVE_ALERT_TYPE = 'treasury_reserve'; // next to TREASURY_BALANCE_ALERT_TYPE

function notifyTreasuryReserveRefusal(deps, input): Promise<NotifyTreasuryReserveRefusalResult>;
// deps: AlertRepository, EmailSender | undefined, AuditEventRepository, Clock, Logger
// Result kinds: opened | deduped | retried | skipped

function resolveTreasuryReserveAlert(deps, input): Promise<ResolveTreasuryReserveAlertResult>;
// Result kinds: resolved | none-open

// src/app/funding/dispatch-funding.ts
function provisionalTopUpAmountWei(input: { walletBalanceWei: bigint; policy: FundingPolicy }): bigint; // deficit toward target, clamped by maximumTopUp
```

Local design choices (T1.8, 2026-07-31):

- **Identity:** entityType `'treasury'`, entityId = treasury.id, alert type
  `treasury_reserve`, severity `critical` (P1-US5). Shares the treasury entity
  with T3.3 balance alerts; depends on C3a `findOpenByEntity(..., alertType)`.
- **Dedupe:** one open reserve alert per treasury. First refusal persist-then-sends
  (`metadata_json.pendingEmail = 'critical'`, `last_sent_at` advances only after
  provider `sent`). Later refusals update `last_evaluated_at` + metadata only.
  **No reminder interval** in T1.8 — re-notification waits until resolve then a
  new refusal.
- **Resolution rule:** resolve when a later funding operation for that treasury
  successfully **submits** a transfer (`dispatchFunding` → `kind: 'submitted'`).
  That is direct evidence demand can be served again. Resolving on a balance
  threshold alone could clear while demand still exceeds spendable. No recovery
  email (no template; P1-US5 requires only the critical refusal signal). Row is
  never deleted (AGENTS.md §9).
- **Requested amount:** `TopUpDecision` blocked variant carries no amount; callers
  pass `provisionalTopUpAmountWei` (clamped deficit). Non-positive amounts skip
  the alert rather than email a misleading zero.
- **Call site:** application-layer `ensureWalletFunded` (and the exported notify /
  resolve helpers for T2.2 ensure-ready and T4.1 reconciler). Not the route
  handler. A burst of N wallet refusals against one treasury produces **one**
  email.
- **Failure isolation:** alert-store / email failures are logged and must not
  change the caller's `FUNDING_BLOCKED_RESERVE` outcome.
- **Audit:** `treasury.alert.email.sent` / `treasury.alert.email.failed` on send
  attempts (same actions as T3.3); `treasury.alert.resolved` on resolve.
- **AlertRepository:** `markPendingEmail` and `touchLastEvaluated` accept optional
  `metadata` merges (additive; pendingEmail key preserved).

### C12 — Treasury row lifecycle (owner: TX.5)

```ts
// HTTP (operator only; enforced in application services)
// PATCH /v1/treasuries/:id  body: { enabled: boolean }  // additionalProperties: false

// Application ports (src/app/ports.ts) — TreasuryRepository extension
setEnabled(id, enabled): Promise<Treasury>;

// Application use case
setTreasuryEnabled(deps, input): Promise<Treasury>;
// deps: TreasuryRepository, AuditEventRepository
// Permission: 'treasury:write' (operator only)
// Audit: treasury.disabled / treasury.enabled with previous/next enabled state
// Unknown id → TREASURY_NOT_FOUND (404)
// Disabling the only enabled treasury for a chain is allowed (fail closed downstream)

// Funding resolution (src/app/funding/ensure-wallet-funded.ts)
// resolveTreasuryForWallet: >1 enabled row for wallet.chain → INVALID_CONFIGURATION
// before any signer call (publicMessage: ambiguous treasury configuration)
```

Local design choices (TX.5, 2026-08-01):

- Closes the hosted Phase 4 silent no-op: an address-only `TREASURY_ADDRESS`
  change inserts a second enabled row; without the guard, funding kept binding
  the oldest row (key still matched) and spent from the retired treasury.
- Option (b) "prefer the signer-matching row" is rejected: it silently
  reinterprets which treasury is authoritative. Ambiguity refuses loudly;
  rotation is change config → refuse → `PATCH` disable retired → resume.
- Reserve accounting, nonce probing, and alert entity ids continue to key off
  the single resolved row; dispatch's `treasury.enabled` snapshot gate remains
  defense-in-depth for a mid-flight disable.

### C4 — Funding operation status values (owner: T1.5)

`funding_operations.status`: `pending | in_progress | succeeded | failed | abandoned`
`funding_transactions.status`: `created | submitted | submission_unknown | confirmed | reverted | replaced | dropped | failed`
Exactly these strings in DB and API JSON. Exhaustive switches required.

`submission_unknown` (added 2026-07-28, migration `0003`) is **non-terminal**: the
submission never returned a confirmed outcome, so the signed transfer may still be
in the mempool. It counts as in-flight for both the per-wallet duplicate gate and
the treasury reserve. Only errors that provably precede broadcast may produce a
terminal `failed` transaction row.

### C5 — Managed wallet registration + policy APIs (owner: T1.3)

```ts
// HTTP (operator mutations; operator + read-only reads)
// POST   /v1/wallets
// GET    /v1/wallets?projectId&environmentId&enabled&limit&offset
// PATCH  /v1/wallets/:id
// PUT    /v1/wallets/:id/policy

// Application ports (src/app/ports.ts)
interface ManagedWalletRepository {
  /* insert/find/list/update + project/env lookup */
}
interface FundingPolicyRepository {
  upsert(input: FundingPolicyUpsertInput): Promise<StoredFundingPolicy>; // version++ on update
  findByManagedWalletId(id: string): Promise<StoredFundingPolicy | undefined>;
}

// Permissions
('wallet:read'); // operator, read-only
('wallet:write'); // operator only
```

Local design choices (T1.3, 2026-07-28):

- Registration body: `projectId`, `environmentId`, numeric EVM `chainId`, wallet `role`,
  `address`; optional `criticalAtStartup` / `reconciliationEnabled` (default false).
- Address validated via Viem `isAddress`/`getAddress`; stored lowercase, returned checksummed.
- Duplicate `(chain_id, address)` → `WALLET_ALREADY_REGISTERED` (unique violation race path).
- Policy amounts are decimal wei strings at the HTTP boundary → `bigint` once via
  `parseWeiDecimalString`; domain `validatePolicy` owns amount invariants.
- Never accept or persist managed-wallet private keys (`additionalProperties: false`).
- Mutations write audit events: `wallet.registered`, `wallet.updated`, `wallet.policy.set`.

### C6 — Scoped authorization (owner: T2.1)

```ts
// src/app/auth/authorize-scope.ts
type ScopeAction = 'read' | 'mutate' | 'fund';

interface AuthorizeScopeInput {
  readonly role: Role;
  readonly credentialId: string;
  readonly action: ScopeAction;
  readonly projectId: string;
  readonly environmentId?: string; // when set, env-level check
}

interface AuthorizeScopeDependencies {
  readonly credentialScopes: CredentialScopeRepository;
}

function authorizeScope(dependencies: AuthorizeScopeDependencies, input: AuthorizeScopeInput): Promise<void>; // throws INSUFFICIENT_ROLE or SCOPE_DENIED

function hasProjectScope(scopes: readonly CredentialScope[], projectId: string): boolean;

function hasEnvironmentScope(
  scopes: readonly CredentialScope[],
  projectId: string,
  environmentId: string,
): boolean;

function resolveReadableProjectIds(
  dependencies: AuthorizeScopeDependencies,
  input: { readonly role: Role; readonly credentialId: string },
): Promise<readonly string[] | undefined>; // undefined = unrestricted
```

Local design choices (T2.1, 2026-07-28):

- Operator: all projects/environments for read and mutate (mutations also require
  `project:write`). Read-only: read all, mutate none. Project-service: read only
  via `api_credential_scopes`; mutate on project/environment admin endpoints denied
  (`INSUFFICIENT_ROLE`). Cron roles: denied (`INSUFFICIENT_ROLE`).
- Null `environment_id` in a scope row grants all environments in that project.
- Env-specific scope rows still allow project-level reads (`hasProjectScope`).
- Project-service does not receive global `project:read`; list/get use
  `assertProjectReadPermission` then `authorizeScope` / `resolveReadableProjectIds`.
- No scope rows ⇒ empty list and `SCOPE_DENIED` on get.

Extension (T1.6, 2026-07-29):

- `fund` action for on-demand funding (`ensure-funded`): operator allowed;
  project-service allowed when scoped to the wallet's project/environment;
  read-only and cron roles denied (`INSUFFICIENT_ROLE`).

### C7 — Funding dispatch engine (owner: T1.5; destination hardening: T1.6)

```ts
// src/app/funding/dispatch-funding.ts — sole path that submits treasury transfers
interface DispatchFundingInput {
  // ... operation metadata, treasury snapshot, policy, balances ...
  readonly walletId: string; // destination address NEVER accepted from callers
}
function dispatchFunding(deps, input): Promise<DispatchFundingResult>;
// deps.managedWallets.findById(walletId) resolves the allowlisted address
// Result kinds: replay | no-op | blocked | submitted
// Throws: FUNDING_DISABLED | ENTITY_DISABLED | PENDING_FUNDING_EXISTS |
//         WALLET_NOT_FOUND | SIGNER_CHAIN_MISMATCH | RPC/signer errors after committing failed status

// src/app/funding/track-transaction.ts
// input requires senderAddress (treasury) so the tracker can probe the nonce
function trackTransaction(deps, input): Promise<TrackTransactionResult>;
// Outcome kinds: confirmed | reverted | replaced | dropped | pending | already-terminal
// Timeout ⇒ pending (D4); never treats submission as confirmation

// src/app/funding/ensure-wallet-funded.ts — HTTP orchestration (T1.6 / P1-US3)
function ensureWalletFunded(deps, input): Promise<EnsureWalletFundedResult>;
// status: no-op | funded | pending | blocked | failed
```

Local design choices (T1.5, 2026-07-28):

- Idempotency: `funding_operations` row committed before any RPC; unique-violation
  race on `(requested_by, idempotency_key)` re-reads the winner.
- Serialization: `pg_advisory_xact_lock(hashtext(treasuryId), evmChainId)` via
  `FundingDispatchLock` (D7); nonce fetch + submit + hash persist share that txn.
- Pending-tx gate: in-flight rows (`created|submitted|submission_unknown`) for the
  same managed wallet abort with `PENDING_FUNDING_EXISTS` (status updates commit,
  then error is thrown).
- Enable gates: `FUNDING_ENABLED`, `FUNDING_KILL_SWITCH`, plus treasury / project /
  environment / wallet `enabled` flags — all fail closed before signing.
- Config: `FUNDING_CONFIRMATIONS` / `FUNDING_CONFIRMATION_TIMEOUT_MS` loaded in
  `FundingConfig` for `trackTransaction` (shared with T2.3).

Security-review hardening (2026-07-28, PR #8 review — see `tasks/SECURITY-REVIEW-T1.5.md`):

- **Reserve accounting includes in-flight transfers.** `calculateTreasurySpendableWei`
  now requires `inFlightWei`, and dispatch supplies
  `transactions.sumInFlightAmountWeiByTreasury(treasuryId)` from inside the lock.
  An `eth_getBalance` read cannot see this treasury's own unmined sends, so without
  this, funding several wallets in one block window collectively breaches the reserve.
- **Ambiguous submissions are never terminal.** Only `PRE_BROADCAST_ERROR_CODES`
  (signer/chain/gas/validation/gating failures) mark a transaction `failed`; every
  other error records `submission_unknown` with the nonce.
- **The receipt tracker requires positive evidence before any terminal state.**
  `waitForOutcome` takes `senderAddress` + `nonce`; an unknown hash yields `replaced`
  only when the account nonce has advanced past it, otherwise `pending`. Transient
  RPC failures can no longer manufacture `dropped`.
- **Destination allowlist (T1.6):** `DispatchFundingInput` accepts only `walletId`.
  `dispatchFunding` resolves the checksummed address via
  `ManagedWalletRepository.findById`, verifies `enabled` and chain match, and
  re-resolves inside the advisory lock. `POST /v1/wallets/:id/ensure-funded`
  request body has `additionalProperties: false` and no address field.
- Open follow-up for **T4.x reconciliation**: resolve `submission_unknown` rows by
  searching for the treasury's transactions at the recorded nonce.

TX.8 amendment (2026-08-01) — in-lock balance re-read before top-up / reserve math:

- **`DispatchFundingDependencies` includes `BalanceReader`.** `ensureWalletFunded`
  passes through the same reader used for its pre-lock observations.
- **`DispatchFundingInput.treasury.address`** is required so dispatch can re-read
  the treasury under the advisory lock. Pre-lock `walletBalanceWei` /
  `treasury.balanceWei` remain the recorded observations and API
  `balanceBeforeWei`; they are **not** the money-path inputs.
- **Inside `pg_advisory_xact_lock`**, after wallet re-resolution and the pending-tx
  gate, dispatch re-reads the destination wallet and treasury balances, then
  recomputes `calculateTopUp` / spendable reserve from those fresh values plus
  the existing in-flight sum. A wallet at-or-above minimum on the in-lock read
  is `no-op` even when the pre-lock observation was below minimum — closing the
  confirm-outside-lock race proven by T1.9 (stale pre-lock read + fast confirm
  clearing the in-flight gate → second transfer).
- **In-lock read failures are terminal pre-broadcast.** They mark the operation
  `failed` with the BalanceReader code (`RPC_UNAVAILABLE` | `CHAIN_ID_MISMATCH`)
  and never create a `funding_transactions` row. `RPC_UNAVAILABLE` stays out of
  `PRE_BROADCAST_ERROR_CODES` so post-`sendNativeTransfer` ambiguity still
  yields non-terminal `submission_unknown` (C4).

### C8 — Funding operation status resume (owner: T2.3)

```ts
// src/app/funding/get-operation-status.ts
type FundingOperationViewStatus =
  'pending' | 'in_progress' | 'succeeded' | 'failed' | 'abandoned' | 'reverted' | 'replaced' | 'dropped'; // never conflate with generic failed

type FundingOperationStatusReason = 'submission-unconfirmed';

function getOperationStatus(
  deps,
  input,
): Promise<{
  readonly operation: FundingOperation;
  readonly transaction: FundingTransaction | undefined;
  readonly status: FundingOperationViewStatus;
  readonly reason: FundingOperationStatusReason | undefined;
}>;
// HTTP: GET /v1/funding-operations/:id
```

Local design choices (T2.3, 2026-07-29):

- Resumes `trackTransaction` only when the linked row is `submitted`, supplying the
  configured treasury address as `senderAddress`. Timeout ⇒ view status `pending`.
- `submission_unknown` cannot be receipt-tracked (no hash). Surfaced as
  `status: 'pending'` + `reason: 'submission-unconfirmed'`; resolution stays with
  Phase 4 reconciliation.
- Reverted / replaced / dropped are distinct view statuses with their
  `TRANSACTION_*` error codes on the operation — never mapped to generic `failed`.
- Authz via `authorizeScope` (C6): operator and read-only see all; project-service
  only when `operation.projectId` is in scope; **deny by default when `projectId`
  is null**. Cron roles → `INSUFFICIENT_ROLE`.
- Endpoint is read-plus-track only: no dispatch, no signing, no `TreasurySigner`
  construction. Response includes wei as decimal strings and explorer URL for
  the transaction hash when present.

### C11 — Environment ensure-ready (owner: T2.2)

```ts
// src/app/funding/ensure-environment-ready.ts
function ensureEnvironmentReady(deps, input): Promise<EnsureEnvironmentReadyResult>;
// HTTP: POST /v1/environments/{id}/ensure-ready
// Body: { idempotencyKey: string }  // additionalProperties: false; required

type EnsureReadyWalletStatus = 'no-op' | 'funded' | 'pending' | 'warning' | 'blocked';
type EnsureReadyOverallStatus = 'ready' | 'degraded' | 'pending' | 'blocked';
```

Local design choices (T2.2, 2026-08-01):

- **Compose, do not fork funding:** calls existing `ensureWalletFunded` once per
  enabled wallet (serial loop). Destination allowlist, reserve, advisory lock,
  audit, and C10 reserve-alert dedupe stay inside that path (C7 / C10).
- **Resolution / authz:** unknown environment → `ENVIRONMENT_NOT_FOUND`. Then
  `authorizeScope` action `'fund'` at `(projectId, environmentId)` — operator
  allowed; project-service when scoped; read-only and cron denied (C6 fund
  extension). Disabled project or environment refuses the **whole** request with
  `ENTITY_DISABLED` (never a silent `ready`).
- **Funding gates:** `FUNDING_DISABLED` / kill switch from `ensureWalletFunded`
  propagate and abort the sweep. No read-only readiness path in this contract.
- **Wallet set:** all **enabled** managed wallets in the environment, paginating
  through every page. A wallet with no funding policy is a per-wallet
  configuration failure (`errorCode`), never skipped.
- **Per-wallet mapping** from `EnsureWalletFundedResult` / caught errors:
  `no-op`→`no-op`, `funded`→`funded`, `pending`→`pending`;
  `blocked`/`failed`/thrown error → `blocked` when `criticalAtStartup`, else
  `warning`. Per-wallet errors are contained so one failure cannot hide others.
- **Overall precedence:** any `blocked` → `blocked`; else any `warning` →
  `degraded`; else any `pending` → `pending`; else `ready`. **Zero eligible
  wallets is `ready`** (nothing to fund).
- **Idempotency:** the caller's key is passed through unchanged to each
  `ensureWalletFunded` call, which namespaces it per wallet as
  `` `${wallet.id}:${key}` ``. Replaying the same environment-level key therefore
  replays each wallet's operation instead of double-funding.
- **Response:** per-wallet entries include `walletId`, checksummed `address`,
  `status`, `operationId` / `reasonCode` / `errorCode` when present, and
  balance/target wei as decimal strings (machine-parsable and operator-debuggable).

### D3 detail — final values, and why they are in version control (2026-07-29)

**Final ladder:** warning **0.75**, critical **0.3**, recovery **1.5**, reserve
**0.1** ETH, declared in `render.yaml` on both services.

Two revisions got here. The first set (warning 1, critical 0.25, recovery 2, reserve
0.5) was valid but put the reserve _above_ critical, which strands the critical
alert — see the note below, which still applies to any ladder shaped that way. The
second attempt set recovery to `.15` where `1.5` was intended; since
`buildTreasuryConfig` runs unconditionally in `loadConfig`, that would have failed
the web service **and** the monitor cron at boot, not just funding.

That second near-miss is why the values are now version-controlled rather than
dashboard-set: CI validates the declared ladder
(`test/unit/config/render-blueprint-thresholds.test.ts`) before it can reach a
service, checking the startup rules, that reserve stays below critical, and that
both services declare identical values. The trade is that changing a threshold is
now a pull request — see `docs/runbooks/change-thresholds-safely.md`.

#### Why reserve must stay below critical

The consequences below are what the CI check exists to prevent. They apply whenever
the reserve sits at or above the critical threshold:

- **The critical alert becomes unreachable through funding.** Spendable is
  `balance − reserve − gas − in-flight`, so funding cannot push the balance below the
  reserve. If the reserve is at or above critical, the balance never falls far enough
  to trigger the critical email through ordinary activity, and that email degrades
  into a "something other than funding drained the treasury" signal (an external
  transfer, or gas burned by the treasury itself).
- **Funding stops with no escalation.** Requests begin failing with
  `FUNDING_BLOCKED_RESERVE` while the treasury still reads `warning`, so the last
  notification the operator received was the warning email fired much earlier.

With the final ladder the first problem is gone: critical (0.3) fires above the
reserve (0.1), giving roughly 0.2 ETH of spendable runway as advance notice.

**The second problem is not fixed by threshold choice.** Nothing yet fires at the
moment funding is actually refused — that is **T1.8** (PRD P1-US5: "A critical
operator email is generated when legitimate demand cannot be served due to reserve
constraints"), still unbuilt. Critical at 0.3 is now a useful early warning, but it is
not the same signal.

**Closed (2026-07-29):** `assertValidTreasuryThresholds` now enforces
`minimumReserveWei < criticalBalanceWei` as a hard error, so every entry point is
covered — hosted, local `.env`, and dashboard override alike — not just the
`render.yaml` values CI reads. The inequality is strict: at equality the critical
alert fires exactly as funding stops, leaving no runway to act on.

Cost of the stricter rule, recorded deliberately: it forbids the otherwise coherent
posture of "protect the treasury aggressively, page me only when nearly empty"
(a high reserve with a much lower critical). That configuration is now rejected,
on the grounds that a critical alert which cannot fire is worse than a
conservative one that can. Every test fixture was updated to a compliant ladder,
which also means fixtures now model a sane production shape rather than the
stranded one.

### C13 — List environments for a project (owner: TX.7)

```ts
// HTTP (operator, read-only, scoped project-service reads)
// GET /v1/projects/:id/environments?limit&offset

// Application ports (src/app/ports.ts) — EnvironmentRepository extension
listByProject(
  projectId: string,
  pagination: { readonly limit: number; readonly offset: number },
): Promise<EnvironmentListPage>; // ordered by createdAt ASC

// Application use case (src/app/projects/list-environments.ts)
function listEnvironments(deps, input): Promise<ListEnvironmentsResult>;
// assertProjectReadPermission → PROJECT_NOT_FOUND if missing → authorizeScope read at project level
```

Local design choices (TX.7, 2026-08-01):

- Mirrors `getProject` authorization order: existence check before scope, so
  out-of-scope callers get `SCOPE_DENIED` only for projects that exist.
- Env-specific scope rows still satisfy project-level read via C6 `hasProjectScope`.
- Pagination uses shared string query schema + `parsePageLimit` / `parsePageOffset`.
- Dashboard replaces wallet-derived environment discovery with this route so
  zero-wallet environments are visible immediately after creation.

### C14 — Reconciliation use case (owner: T4.1)

```ts
// Permission (src/domain/auth/roles.ts)
'reconciliation:run'; // cron-reconciler only; API roles denied
// No HTTP endpoint in T4.1 — T4.2 cron entry calls the use case directly.

// src/app/reconciliation/reconcile-wallets.ts
function reconcileWallets(deps, input): Promise<ReconcileWalletsResult>;
// input: { role, credentialId, correlationId, runId? }
// Idempotency key per wallet: `reconcile:<runId>:<walletId>`
// operationType: 'reconcile'; requestedBy: credentialId (cron)

// Ports (src/app/ports.ts)
interface TreasuryOutgoingScanner {
  getConfirmedTransactionCount(address): Promise<ConfirmedNonceResult>;
  findOutgoingByNonce({ fromAddress, nonce, lookbackBlocks }): Promise<FindByNonceResult>;
  listRecentOutgoingTransfers({ fromAddress, lookbackBlocks }): Promise<OutgoingScanResult>;
}
interface ReconciliationRunRepository {
  insertStarted / markFinished / findById;
}
interface ReconciliationFundingQuery {
  listSubmissionUnknownByTreasury(treasuryId);
  listRecordedTransactionHashesByTreasury(treasuryId);
}
```

Local design choices (T4.1, 2026-08-01):

- **Compose C7 only:** every submit goes through `dispatchFunding`; never a parallel
  signing path. Serial wallet loop; advisory lock serializes against API funding
  (P4-US2).
- **Eligibility:** enabled wallet + `reconciliationEnabled` + enabled project +
  enabled environment. Paginate `managedWallets.list({ enabled: true })` to
  completion; filter the rest in-app (never silently cap).
- **Top-up rule (P4-US1 / C2):** fund only when fresh balance is **below** minimum;
  at-or-above minimum is a no-op even when below target.
- **Reserve stop-and-continue:** first `blocked/reserve` (or post-stop assessment)
  records the wallet and continues the sweep; later below-minimum wallets are
  assessed as blocked without submitting. C10 `notifyTreasuryReserveRefusal` /
  `resolveTreasuryReserveAlert` reuse the ensure-funded pattern (actor
  `{ type: 'cron', id: credentialId }`) — one alert per treasury per burst.
- **Run summary storage:** new table `reconciliation_runs` (migration `0004`), not
  a typed `funding_operations` row — run-level counters and findings are not a
  per-wallet funding operation. Columns: assessed/funded/noop/blocked/failed,
  wei transferred, submission_unknown resolved/left-pending, unexplained transfer
  count, outgoing scan status, findings JSON, started/finished timestamps.
- **`submission_unknown` settlement (C4):** confirmed account nonce ≤ recorded
  nonce → leave pending. When nonce has advanced, scan for the treasury transfer
  at that nonce within the lookback. Match on destination + amount →
  `markSubmitted` then `trackTransaction`. Different transfer → `markReplaced`.
  RPC incomplete or no evidence within lookback → leave pending and report —
  never guess a terminal state.
- **Crash-orphan detection (T1.9 follow-up):** scan treasury outgoing native
  transfers (`value > 0`) over the lookback; compare hashes to recorded
  `funding_transactions.transaction_hash` rows. Unexplained transfers are
  **critical** findings in the run summary and are **never** silently inserted
  into history (possible crash-orphan or key compromise). RPC scan failure ⇒
  finding `outgoing_scan_incomplete`, status `incomplete` — not a clean report.
- **Lookback bound:** default `20_000` blocks (~2.8 days at Sepolia ~12s). Passed
  as `ReconcileWalletsDependencies.outgoingLookbackBlocks`; env
  `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` registered for T4.2 to wire into config.
- **Authz:** `assertPermission(role, 'reconciliation:run')`. Operator /
  project-service / read-only lack the permission. No route registration in this
  task.

T4.2 amendment (2026-08-01) — cron wiring / exit semantics (no new contract number):

- Service role `cron-reconciler` is signing-capable (`isSigningCapableRole`); loads
  `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` (default `20000`), funding/signer settings,
  thresholds, and email (for T4.3 alerting in-process). Heartbeat key is
  `wallet-reconciler` (listed by `/health/ready` beside `web` and `treasury-monitor`).
- Exit: run-level malfunction (`error_code` other than unset/`FUNDING_DISABLED`) →
  process exit **non-zero**. `FUNDING_DISABLED` / kill switch is **policy** → record
  the run, log clearly, exit **zero** (a week-long kill switch must not page every
  six hours). Startup logs any `reconciliation_runs` with `finished_at IS NULL`
  (aborted; never treat default `outgoing_scan_status='complete'` as clean).
- Render: `chainbank-wallet-reconciler` cron every 6h; `TREASURY_PRIVATE_KEY` on web
  - reconciler only — never on `chainbank-treasury-monitor`.

## 3. Configuration registry (new env vars — add rows as you add vars)

| Var                                  | Service roles                  | Required                    | Default                                          | Owner task                  |
| ------------------------------------ | ------------------------------ | --------------------------- | ------------------------------------------------ | --------------------------- |
| `TREASURY_PRIVATE_KEY`               | web (funding), reconciler cron | when `FUNDING_ENABLED=true` | —                                                | T1.4                        |
| `FUNDING_ENABLED`                    | all                            | no                          | `false`                                          | exists (gate flips in T1.4) |
| `FUNDING_KILL_SWITCH`                | all                            | no                          | `false` (true blocks all signing, reads stay up) | T1.4                        |
| `TREASURY_MINIMUM_RESERVE_ETH`       | web, reconciler                | yes                         | — (parsed to `minimumReserveWei`)                | exists (enforced in T1.6)   |
| `FUNDING_CONFIRMATIONS`              | web, reconciler                | no                          | `1`                                              | T1.5 (resume UX in T2.3)    |
| `FUNDING_CONFIRMATION_TIMEOUT_MS`    | web                            | no                          | `60000`                                          | T1.5 (resume UX in T2.3)    |
| `ALERT_REMINDER_INTERVAL_HOURS`      | treasury-monitor cron          | no                          | `24`                                             | T3.3                        |
| `RECONCILE_FAILURE_ALERT_THRESHOLD`  | reconciler                     | no                          | `3`                                              | T4.3                        |
| `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` | reconciler                     | no                          | `20000`                                          | T4.2 (registered in T4.1)   |

## 4. Decision log (append-only)

- 2026-07-28 — Plan created; Phase 0 complete; Phases 1–4 scoped as "finish the application"; Phases 5–8 out of scope for this effort.
- 2026-07-28 — T1.2 published concrete C2 types (`FundingPolicy`, `PolicyValidationResult`, `calculateTreasurySpendableWei`) and decision precedence for `calculateTopUp`.
- 2026-07-28 — PR #2 merged (T1.1 + T1.2 + T1.4). Wave 2 launched: T1.5, T1.3, T3.1. Prompts issued for T3.2, T2.1, TX.1. Added D9 (gitleaks for CI secret scan) and D10 (`api_credential_scopes` table for project-service authorization).
- 2026-07-28 — T2.1 published scoped authorization contract C6 (`authorizeScope`, `hasProjectScope`, `hasEnvironmentScope`, `resolveReadableProjectIds`) and migration `0002` for `api_credential_scopes`.
- 2026-07-28 — T3.1 published `OpenAlertState`, `applyAlertTransition`, and recovery-hysteresis alert bands under C3.
- 2026-07-28 — T1.3 published managed-wallet registration/policy API contract C5 (`wallet:read`/`wallet:write`, versioned policy upsert, audit actions).
- 2026-07-28 — T1.5 published C7 (`dispatchFunding`, `trackTransaction`; originally numbered C5, renumbered at rebase), wired confirmation env vars into `FundingConfig`, and documented advisory-lock + idempotency crash-recovery behavior.
- 2026-07-28 — Security review of PR #8 confirmed two invariant defects; both fixed on that branch (in-flight reserve accounting, non-terminal `submission_unknown`, evidence-based receipt classification) with migration `0003`. A third observation — the destination allowlist enforced only by contract comment — was judged not-reportable today and recorded as a binding T1.6 review requirement. Full report: `tasks/SECURITY-REVIEW-T1.5.md`.
- 2026-07-29 — PRs #4–#9 all merged; Wave 2 complete (T1.1–T1.5, T2.1, T3.1, T3.2, TX.1, TX.2). D8 corrected to moot — `@fastify/rate-limit` predated the plan. Remaining PENDING decisions: D3 (real threshold values, operator-owned, config-only) and D6 (e2e chain tooling, needed before T4.4). Next wave: T1.6, T2.3, T3.3, T1.7.
- 2026-07-29 — T2.3 published funding operation status resume contract C8
  (`getOperationStatus`, `GET /v1/funding-operations/:id`; confirmation resume,
  `submission_unknown` → pending + `submission-unconfirmed`, distinct
  reverted/replaced/dropped view statuses).
- 2026-07-29 — T3.3 wired alert persistence + orchestration: `AlertRepository` over migration `0001` `alerts` (append-oriented resolve), `evaluateTreasuryAlerts` shared by treasury-monitor cron and `POST /v1/treasuries/:id/check`, `ALERT_REMINDER_INTERVAL_HOURS` (default 24) in config. Persist-then-send uses `metadata_json.pendingEmail` so a failed send does not advance `last_sent_at` and is retried next run. Monitor role now loads email settings; still strips `TREASURY_PRIVATE_KEY`.
- 2026-07-29 — T1.6 published `POST /v1/wallets/:id/ensure-funded` (`ensureWalletFunded`), extended C6 with `fund` scope action, and hardened C7 so `dispatchFunding` accepts only `walletId` and resolves the destination via `ManagedWalletRepository.findById` (AGENTS.md §7.1). Reserve continues to use existing `TREASURY_MINIMUM_RESERVE_ETH` / `minimumReserveWei`.
- 2026-07-29 — Security review of PR #13 confirmed the destination-allowlist requirement is met, and found three latent weaknesses that this PR turned into money-path exposures; all fixed on the branch: rate limiting keyed on the bearer-token hash (the `request.actor` key was dead code at `onRequest`), `TRUSTED_PROXY_HOPS` (default 1) replacing `trustProxy: true` so `X-Forwarded-For` cannot forge `request.ip`, `assertSignerMatchesTreasury` binding the signing key to the reserve-enforced treasury row, and idempotency keys namespaced by wallet id. Full report: `tasks/SECURITY-REVIEW-T1.6.md`.
- 2026-07-30 — T3.4 added the ten PRD §19 operational runbooks under `docs/runbooks/` plus an index. Documented Known gaps (no credential revoke tooling, no treasury enable API, env-only kill switch, deferred `submission_unknown` resolution) rather than inventing operator commands. Threshold changes remain env+redeploy via `registerConfiguredTreasury` upsert; treasury address change creates a new `(chain_id, address)` row.
- 2026-07-29 — D3 resolved by the operator from the Render environment: warning 1 / critical 0.25 / recovery 2 / reserve 0.5 ETH. Values pass `assertValidTreasuryThresholds`. Recorded the reserve-between-critical-and-warning consequence (funding halts while status still reads `warning`; the critical email is not the funding-stopped signal) and the un-validated `minimumReserveWei` gap. Raises T1.8's priority. Remaining PENDING decision: D6 only.
- 2026-07-29 — D3 thresholds moved from Render dashboard (`sync: false`) into `render.yaml` as literal values on both services, after a `.15`-for-`1.5` recovery typo that would have failed both processes at boot. Final ladder: warning 0.75 / critical 0.3 / recovery 1.5 / reserve 0.1 ETH. CI now validates the declared ladder (startup rules, reserve < critical, both services identical) via `test/unit/config/render-blueprint-thresholds.test.ts`; guards mutation-tested. Changing a threshold is now a PR — see `docs/runbooks/change-thresholds-safely.md`.
- 2026-07-29 — D6 penciled in as Anvil (external binary, spawned only if on `PATH`, suite skips otherwise — no npm dependency, so AGENTS.md §14 is not engaged). To reconfirm when T4.4 starts. Added **TX.6**: `AlertRepository.findOpenByEntity` ignores `alert_type`, so a second alert type on the `treasury` entity would collide with T3.3's balance alerts and break P3-US2 exactly-once email semantics. Sequenced before T1.8 because only one alert type exists today, making the filter provably a no-op on current data; doing it afterward would require migrating the entity key on live alert rows instead.
- 2026-07-30 — TX.6 closed the alert-type lookup gap: `AlertRepository.findOpenByEntity(entityType, entityId, alertType)` now filters on `alert_type` (C3a), so T1.8 reserve alerts and later types can share a treasury entity without colliding with balance alerts.
- 2026-07-30 — TX.4 published credential admin contract C9: operator-only `GET/PATCH /v1/admin/credentials`, `credential:read`/`credential:write` permissions, disable vs revoke semantics, self-mutation guard, audited mutations (AGENTS.md §7.7 / PRD §14).
- 2026-07-30 — TX.4 follow-ups closed: added `enable` to the credential admin API (C9) so a mistaken **disable** is reversible in-product, while **revoke** stays terminal (`CREDENTIAL_REVOKED`, 409) because the endpoint that removes a leaked token must not restore it. The self-mutation guard now covers all three actions, which makes a second operator credential a prerequisite rather than a nicety — issued at deploy time (runbook step 4) and stated in the runbook index. Removes the last SQL-only rollback from the credential runbooks.
- 2026-07-31 — T2.4 extended the operator dashboard with projects, environments, managed wallets, and funding-policy views (PRD §12.2 / P2-US1). Panels load independently (no cross-panel `Promise.all`); pagination query values are stringified via `URLSearchParams`; wei display/edit uses BigInt only. Environments for a selected project are discovered from `GET /v1/wallets?projectId=` because no list-by-project environments route exists; detail still uses `GET /v1/environments/:id`.
- 2026-07-31 — T1.8 published C10: treasury-scoped `treasury_reserve` critical alert on `FUNDING_BLOCKED_RESERVE`, persist-then-send dedupe, resolve when a later transfer for that treasury submits successfully. Closes the operator-signal gap between the warning email and reserve refusals (P1-US5 / D3 detail).
- 2026-08-01 — TX.7 published C13: `GET /v1/projects/:id/environments` with `EnvironmentRepository.listByProject`, `getProject`-style scoped reads, and shared string pagination; dashboard no longer discovers environments via wallets.
- 2026-08-01 — TX.5 published C12: operator-only `PATCH /v1/treasuries/:id` `{ enabled }`, `treasury:write`, audited enable/disable, and fail-closed ambiguity guard in `resolveTreasuryForWallet` when more than one enabled treasury exists for a chain. Closes the address-only `TREASURY_ADDRESS` silent no-op proven in hosted Phase 4. (Originally handed off as "C11"; renumbered by the planner — C11 is pre-assigned to T2.2.)
- 2026-08-01 — T2.2 published C11: `POST /v1/environments/{id}/ensure-ready` composes `ensureWalletFunded` per enabled wallet with overall ready/degraded/pending/blocked precedence and env-level idempotency key namespaced per wallet.
- 2026-08-01 — T1.9 added concurrency/crash-recovery integration coverage for `ensureWalletFunded` and the ensure-funded route (parallel distinct keys, route idempotency namespacing, C4 in-flight pending-tx gate, advisory-lock abort behavior, reserve in-flight accounting under parallelism). No new interface contract. Confirmed two follow-ups for the operator: the confirm-outside-lock race (stale balance read + fast confirmation can double-fund a wallet across distinct keys) and the crash-after-broadcast gap (terminated backend rolls back the in-lock rows, so a broadcast transfer can leave no DB trace for reconciliation).
- 2026-08-01 — TX.8 amended C7: `dispatchFunding` re-reads wallet and treasury balances inside the advisory lock and recomputes top-up / reserve from those fresh values, so a confirm-outside-lock race cannot sign a second transfer from a stale pre-lock observation (AGENTS.md §7.3).
- 2026-08-01 — T4.1 published C14: `reconcileWallets` use case (below-minimum sweep via `dispatchFunding`, reserve stop-and-continue, `submission_unknown` evidence-based settlement, crash-orphan outgoing scan, `reconciliation_runs` migration `0004`, permission `reconciliation:run` for cron-reconciler only).
- 2026-08-01 — TX.3 (Wave 4 close refresh): README and PRD §25 appendix updated to merged state — ensure-ready (C11), treasury lifecycle (C12), list-environments (C13), armed hosted funding, TX.8 race closed, T4.1 reconciliation use case landed (C14) with cron wiring pending in T4.2.
- 2026-08-01 — T4.2 wired `cron-reconciler` job + Render blueprint: signing-capable role, lookback/email config, exit semantics (policy vs malfunction), `wallet-reconciler` heartbeat; C14 amended in place (no new contract number).
