# ChainBank Shared Decisions Doc

Single source of truth for cross-task decisions. Workers: read this before starting;
if your task needs a PENDING decision, stop and flag it rather than guessing
(AGENTS.md §1.7). When you make a local design choice other tasks will depend on,
add it under "Interface contracts" in your PR.

Status values: **PENDING** (blocks dependent work), **DECIDED** (cite date + decider),
**SUPERSEDED** (link replacement).

---

## 1. Open product/architecture decisions

| #   | Question                                                                       | Status            | Decision                                                                                                                                                                                                                                             | Date       | Decider                                  |
| --- | ------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| D1  | Signing key: Render secret env var for MVP, or external signer before Phase 1? | DECIDED (default) | Render secret env (`TREASURY_PRIVATE_KEY`) behind the `TreasurySigner` interface; external signer is a later swap. Only signing-capable services receive the secret group.                                                                           | 2026-07-28 | planner (override if operator disagrees) |
| D2  | Dashboard auth: operator API tokens or identity provider?                      | DECIDED (default) | Operator bearer tokens (existing hashed-credential system). No IdP in MVP.                                                                                                                                                                           | 2026-07-28 | planner                                  |
| D3  | Exact warning / critical / recovery / reserve balances for ForteL2             | PENDING           | Config-only values; engineering unblocked. Operator sets real numbers in Render env.                                                                                                                                                                 | —          | operator                                 |
| D4  | Startup confirmation count on Sepolia                                          | DECIDED (default) | 1 confirmation, configurable via `FUNDING_CONFIRMATIONS` (default 1), timeout `FUNDING_CONFIRMATION_TIMEOUT_MS` (default 60000). Timeout ⇒ `pending`, never failure.                                                                                 | 2026-07-28 | planner                                  |
| D5  | Local dev DB: SQLite locally or local Postgres?                                | DECIDED           | Local Postgres without Docker (Postgres.app / Homebrew) — already the Phase 0 convention. No SQLite path.                                                                                                                                            | 2026-07-28 | existing repo convention                 |
| D6  | E2E chain: Anvil, or mocked JSON-RPC only?                                     | PENDING           | Proposal: `anvil` (foundry) as an opt-in dev dependency-free external tool (spawned if on PATH, suite skips otherwise); unit/integration suites use mocked JSON-RPC and Viem test accounts. Needs approval per AGENTS.md §14 before any new package. | —          | operator                                 |
| D7  | Reconciliation lock mechanism                                                  | DECIDED (default) | Postgres advisory lock (`pg_advisory_xact_lock`) keyed by (treasury, chain) hash, plus a `funding_operations` row-level state machine for idempotency. No new dependency.                                                                            | 2026-07-28 | planner                                  |
| D8  | Rate limiting implementation                                                   | DECIDED (moot)    | `@fastify/rate-limit` was already a dependency from the Phase 0 bootstrap and is registered in `src/api/app.ts` alongside helmet and deny-by-default CORS. Raised as needing approval in error; no new dependency was ever introduced.               | 2026-07-29 | planner (correction)                     |
| D9  | CI secret-scan tooling                                                         | DECIDED (default) | `gitleaks` official GitHub Action, pinned by commit SHA. A CI action, not an npm dependency; override if operator prefers another scanner.                                                                                                           | 2026-07-28 | planner                                  |
| D10 | Credential project/environment scoping storage                                 | DECIDED (default) | New `api_credential_scopes` table (credential FK + project FK + nullable environment FK), migration `0002`, owned by T2.1. Null environment = all environments in that project. Non-scoped roles (operator, read-only, crons) ignore the table.      | 2026-07-28 | planner                                  |

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

- Signing-capable role today: `web` only (`isSigningCapableRole`). Future reconciler
  joins that helper; `treasury-monitor` always strips `TREASURY_PRIVATE_KEY` before
  parse and never constructs a signer.
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
type ScopeAction = 'read' | 'mutate';

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

### C7 — Funding dispatch engine (owner: T1.5)

```ts
// src/app/funding/dispatch-funding.ts — sole path that submits treasury transfers
function dispatchFunding(deps, input): Promise<DispatchFundingResult>;
// Result kinds: replay | no-op | blocked | submitted
// Throws: FUNDING_DISABLED | ENTITY_DISABLED | PENDING_FUNDING_EXISTS |
//         SIGNER_CHAIN_MISMATCH | RPC/signer errors after committing failed status

// src/app/funding/track-transaction.ts
// input requires senderAddress (treasury) so the tracker can probe the nonce
function trackTransaction(deps, input): Promise<TrackTransactionResult>;
// Outcome kinds: confirmed | reverted | replaced | dropped | pending | already-terminal
// Timeout ⇒ pending (D4); never treats submission as confirmation
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
- Open follow-up for **T1.6**: the endpoint must resolve the destination solely via
  `ManagedWalletRepository.findById(walletId)` (checking `enabled` and chain), never
  from request input, with a test rejecting an arbitrary address (AGENTS.md §7.1).
- Open follow-up for **T4.x reconciliation**: resolve `submission_unknown` rows by
  searching for the treasury's transactions at the recorded nonce.

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

## 3. Configuration registry (new env vars — add rows as you add vars)

| Var                                 | Service roles                  | Required                    | Default                                          | Owner task                  |
| ----------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------------ | --------------------------- |
| `TREASURY_PRIVATE_KEY`              | web (funding), reconciler cron | when `FUNDING_ENABLED=true` | —                                                | T1.4                        |
| `FUNDING_ENABLED`                   | all                            | no                          | `false`                                          | exists (gate flips in T1.4) |
| `FUNDING_KILL_SWITCH`               | all                            | no                          | `false` (true blocks all signing, reads stay up) | T1.4                        |
| `TREASURY_RESERVE_WEI`              | web, reconciler                | when funding enabled        | —                                                | T1.6                        |
| `FUNDING_CONFIRMATIONS`             | web, reconciler                | no                          | `1`                                              | T1.5 (resume UX in T2.3)    |
| `FUNDING_CONFIRMATION_TIMEOUT_MS`   | web                            | no                          | `60000`                                          | T1.5 (resume UX in T2.3)    |
| `ALERT_REMINDER_INTERVAL_HOURS`     | treasury-monitor cron          | no                          | `24`                                             | T3.3                        |
| `RECONCILE_FAILURE_ALERT_THRESHOLD` | reconciler                     | no                          | `3`                                              | T4.3                        |

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
