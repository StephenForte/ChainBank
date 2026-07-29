# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting.

## Status (updated 2026-07-29)

**All work through Wave 2 is merged to `main`.** No open PRs, no stale branches.
`main` is at 204 unit tests across 29 files, plus 31 integration tests, with CI
(format, lint, typecheck, unit, build, audit, secret scan, migration validation)
green on every PR.

| Task                                                         | Status      | Landed in          |
| ------------------------------------------------------------ | ----------- | ------------------ |
| T1.1 schema + migration `0001`                               | ✅ done     | PR #2              |
| T1.2 funding math domain                                     | ✅ done     | PR #2              |
| T1.3 wallet registration + policy APIs                       | ✅ done     | PR #7              |
| T1.4 signer infrastructure                                   | ✅ done     | PR #2              |
| T1.5 funding dispatch engine                                 | ✅ done     | PR #8              |
| T2.1 projects/environments + scoped authz (migration `0002`) | ✅ done     | PR #7              |
| T3.1 alert state machine                                     | ✅ done     | PR #5              |
| T3.2 email templates                                         | ✅ done     | PR #6              |
| TX.1 CI pipeline                                             | ✅ done     | PR #4, fixed in #9 |
| TX.2 API hardening (helmet, CORS, rate limit)                | ✅ done     | Phase 0 bootstrap  |
| Everything else                                              | not started | —                  |

**T1.5 was security-reviewed** (`tasks/SECURITY-REVIEW-T1.5.md`). Two confirmed
findings were fixed before merge: in-flight transfers now count against the treasury
reserve, and ambiguous submission outcomes record the non-terminal
`submission_unknown` status (migration `0003`) instead of a terminal state. A third
observation became a **mandatory requirement on T1.6** — see that task below.

**Funding is still disabled end to end.** No HTTP route reaches `dispatchFunding`,
and `FUNDING_ENABLED` must stay `false` until T1.6 lands and runbooks exist.

### Next wave (all unblocked, run in parallel)

T1.6 🔴, T2.3 🔴, T3.3 🔴, T1.7 🟢 — see prompts guidance in the task entries below.

## Task tree

Legend: 🔴 = strongest model (security/money/concurrency path) · 🟢 = cheaper model OK
`[deps]` = must merge first.

### Phase 1 — Treasury MVP and on-demand funding

- **T1.1** ✅ 🟢 Schema expansion + migration `[none]` — DONE (PR #2)
  `projects`, `environments`, `managed_wallets`, `funding_policies`,
  `funding_operations`, `funding_transactions`, `alerts` per PRD §13, migration `0001`.
- **T1.2** ✅ 🔴 Funding math domain `[none]` — DONE (PR #2)
  Pure `src/domain/funding/`: policy validation, top-up calculation, reserve
  calculation (contract C2). Extended in PR #8 to require `inFlightWei`.
- **T1.3** ✅ 🟢 Wallet registration + policy APIs `[T1.1, T1.2]` — DONE (PR #7)
  `POST/GET /v1/wallets`, `PATCH /v1/wallets/:id`, `PUT /v1/wallets/:id/policy`,
  Viem address validation + normalization, duplicate rejection, audit events.
- **T1.4** ✅ 🔴 Signer infrastructure `[none]` — DONE (PR #2)
  `TreasurySigner` (contract C1), fail-closed key config, chain-ID verification,
  `FUNDING_KILL_SWITCH`; monitor cron still boots with no key.
- **T1.5** ✅ 🔴 Funding dispatch engine `[T1.1, T1.4]` — DONE (PR #8)
  Contract C4/C7 state machines, idempotency before submission, per-treasury
  advisory lock (D7), nonce inside the lock, pending-tx gate, receipt tracking,
  in-flight reserve accounting, `submission_unknown` handling. DB-down ⇒ no signing.
- **T1.6** 🔴 `POST /v1/wallets/{id}/ensure-funded` `[T1.2, T1.3, T1.5]` — **next**
  Fresh balance read, top-up calc, reserve + max-top-up re-checked immediately
  before signing, idempotency-key handling, before/target/transfer response.
  **Mandatory (T1.5 security review):** resolve the destination address only via
  `ManagedWalletRepository.findById(walletId)` — verify it exists, is enabled, and
  matches the treasury chain — never from request input, with a test rejecting an
  arbitrary caller-supplied address (AGENTS.md §7.1). Preferred: change the dispatch
  input contract to take only `wallet.id` and resolve the address internally.
- **T1.7** 🟢 Funding history API + dashboard `[T1.5]` — **next**
  `GET /v1/funding-transactions` with filters + pagination, explorer links,
  dashboard table including failed/abandoned and `submission_unknown` rows.
- **T1.8** 🟢 Reserve-exhaustion alert email `[T1.5, T3.1, T3.2]`
  Critical email when legitimate demand is rejected for reserve; alert row dedupe.
  Template already exists (`funding-unavailable-reserve-template.ts`); this is wiring.
- **T1.9** 🔴 Concurrency integration tests `[T1.5, T1.6]`
  Parallel ensure-funded, lock expiry/crash recovery, idempotency replay,
  pending-tx dedupe. Extends the 31 integration tests already on `main`.

### Phase 2 — Projects, environments, readiness

- **T2.1** ✅ 🟢 Projects/environments APIs + scoped authz `[T1.1]` — DONE (PR #7)
  CRUD per P2-US1, `api_credential_scopes` (migration `0002`, D10),
  `authorizeScope` (contract C6), deny-by-default, disable-without-delete.
- **T2.2** 🔴 `POST /v1/environments/{id}/ensure-ready` `[T1.6, T2.1]`
  Orchestrates all startup wallets: parallel reads, serialized dispatch, per-wallet
  no-op/funded/pending/warning/blocked, overall ready/degraded/pending/blocked,
  idempotency key, concurrent-request safety.
- **T2.3** 🔴 Confirmation wait + status resume `[T1.5]` — **next**
  Configurable confirmations/timeout (D4), timeout ⇒ `pending`,
  `GET /v1/funding-operations/{id}` resumes tracking, replaced/reverted explicit.
  Note: `trackTransaction` now requires `senderAddress`; the resume endpoint must
  supply the treasury address. `submission_unknown` rows cannot be receipt-tracked
  (no hash) — surface them as pending and leave resolution to T4.x reconciliation.
- **T2.4** 🟢 Dashboard: projects/environments/wallets/policy views `[T2.1, T1.7]`
  Dashboard is still Phase 0 only (treasury status + readiness).

### Phase 3 — Treasury monitoring and email alerts

- **T3.1** ✅ 🔴 Alert state machine domain `[T1.1]` — DONE (PR #5)
  Pure `src/domain/alerts/` (contract C3), injected clock, exhaustive tests.
- **T3.2** ✅ 🟢 Email templates `[none]` — DONE (PR #6)
  Six operator templates per PRD §12.3 plus the pre-existing test message.
- **T3.3** 🔴 Treasury monitor cron alert integration `[T3.1, T3.2]` — **next**
  Cron drives transitions + sends emails, persists alert state, manual protected
  check-now stays read-only, no signing key in this process. Both halves already
  exist and tested; this is the wiring plus `ALERT_REMINDER_INTERVAL_HOURS`.
- **T3.4** 🟢 Runbooks `[T3.3]`
  All ten PRD §19 runbooks in `docs/runbooks/` (only the Phase 0 deploy one exists).
  Required before Phase 3 exit and before enabling scheduled signing.

### Phase 4 — Managed-wallet reconciliation

- **T4.1** 🔴 Reconciliation use case `[T1.5, T1.6]`
  Load enabled+eligible wallets, fresh reads, top-up below-minimum only, stop at
  reserve, run-level summary row. **Also owns:** resolving `submission_unknown` rows
  by searching the treasury's transactions at the recorded nonce (T1.5 review follow-up).
- **T4.2** 🟢 Reconciler cron entry + Render blueprint `[T4.1]`
  `src/jobs/wallet-reconciler.ts`, every-6h cron in `render.yaml`, separate signing
  secret group, pool closed on exit.
- **T4.3** 🟢 Reconciliation failure alerting `[T4.1, T3.1, T3.2]`
  Consecutive-failure threshold, affected wallets + error categories, recovery
  recorded after success. Template already exists.
- **T4.4** 🔴 Cron-vs-API concurrency e2e `[T4.2, T2.2]`
  Reconciler and ensure-ready racing the same treasury: no duplicate transfers,
  no nonce conflicts.

### Cross-cutting

- **TX.1** ✅ 🟢 CI hardening — DONE (PR #4, gitleaks token/permission fixed in PR #9)
  format, lint, typecheck, unit, build, `npm audit`, gitleaks, migration validation
  - integration tests against a Postgres service container. Actions pinned by SHA.
- **TX.2** ✅ 🟢 API hardening — DONE (Phase 0 bootstrap)
  `@fastify/helmet`, `@fastify/cors` (deny-by-default), `@fastify/rate-limit` are
  registered in `src/api/app.ts`. D8 was a false blocker — the dependency predated
  the plan.
- **TX.3** 🟢 Docs/README per phase `[rolling]`
  README currently describes Phase 1 in progress; refresh again when T1.6 lands and
  funding becomes reachable.

## Remaining wave order

1. **Wave 3 (now, parallel):** T1.6 🔴, T2.3 🔴, T3.3 🔴, T1.7 🟢
2. **Wave 4:** T2.2, T1.8, T1.9, T3.4, T2.4
3. **Wave 5:** T4.1 → T4.2 / T4.3 → T4.4, TX.3

Merge-order caution for Wave 3: T1.6 and T2.3 both touch the funding application
layer and `src/api/`; land whichever finishes first, then rebase the other.
