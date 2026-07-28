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
| D8  | Rate limiting implementation                                                   | PENDING           | Proposal: `@fastify/rate-limit` (official plugin). Needs dependency approval.                                                                                                                                                                        | —          | operator                                 |

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
type AlertTransition =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly severity: 'warning' | 'critical' }
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
```

### C4 — Funding operation status values (owner: T1.5)

`funding_operations.status`: `pending | in_progress | succeeded | failed | abandoned`
`funding_transactions.status`: `created | submitted | confirmed | reverted | replaced | dropped | failed`
Exactly these strings in DB and API JSON. Exhaustive switches required.

## 3. Configuration registry (new env vars — add rows as you add vars)

| Var                                 | Service roles                  | Required                    | Default                                          | Owner task                  |
| ----------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------------ | --------------------------- |
| `TREASURY_PRIVATE_KEY`              | web (funding), reconciler cron | when `FUNDING_ENABLED=true` | —                                                | T1.4                        |
| `FUNDING_ENABLED`                   | all                            | no                          | `false`                                          | exists (gate flips in T1.4) |
| `FUNDING_KILL_SWITCH`               | all                            | no                          | `false` (true blocks all signing, reads stay up) | T1.4                        |
| `TREASURY_RESERVE_WEI`              | web, reconciler                | when funding enabled        | —                                                | T1.6                        |
| `FUNDING_CONFIRMATIONS`             | web, reconciler                | no                          | `1`                                              | T2.3                        |
| `FUNDING_CONFIRMATION_TIMEOUT_MS`   | web                            | no                          | `60000`                                          | T2.3                        |
| `ALERT_REMINDER_INTERVAL_HOURS`     | treasury-monitor cron          | no                          | `24`                                             | T3.3                        |
| `RECONCILE_FAILURE_ALERT_THRESHOLD` | reconciler                     | no                          | `3`                                              | T4.3                        |

## 4. Decision log (append-only)

- 2026-07-28 — Plan created; Phase 0 complete; Phases 1–4 scoped as "finish the application"; Phases 5–8 out of scope for this effort.
- 2026-07-28 — T1.2 published concrete C2 types (`FundingPolicy`, `PolicyValidationResult`, `calculateTreasurySpendableWei`) and decision precedence for `calculateTopUp`.
