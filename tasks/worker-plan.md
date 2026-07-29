# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting.

## Status (updated 2026-07-28)

- ✅ **Done, merged to main (PR #2):** T1.1, T1.2, T1.4
- ✅ **Merged to main:** T1.1, T1.2, T1.4 (PR #2); lint-debt cleanup (PR #3); TX.1 (PR #4); T3.1 (PR #5); T3.2 (PR #6); T1.3 + T2.1 (PR #7)
- 🔄 **In review:** T1.5 (PR #8, this branch)
- Everything else: not started. Next wave: T1.6, T2.3, T3.3, T1.7.

## Task tree

Legend: 🔴 = strongest model (security/money/concurrency path) · 🟢 = cheaper model OK
`[deps]` = must merge first.

### Phase 1 — Treasury MVP and on-demand funding

- **T1.1** ✅ 🟢 Schema expansion + migration `[none]` — DONE (PR #2)
  Add `projects`, `environments`, `managed_wallets`, `funding_policies`,
  `funding_operations`, `funding_transactions`, `alerts` tables per PRD §13,
  with FKs, uniques (incl. partial unique on idempotency key), numeric(78,0),
  Drizzle migration `0001`.
- **T1.2** ✅ 🔴 Funding math domain `[none]` — DONE (PR #2)
  Pure `src/domain/funding/`: policy validation, top-up calculation,
  reserve calculation, contract C2. bigint only, exhaustive unit tests.
- **T1.3** 🔄 🟢 Wallet registration + policy APIs `[T1.1, T1.2]` — IN PROGRESS
  `POST/GET /v1/wallets`, policy create/update, address validation +
  normalization via Viem, duplicate rejection, enable/disable, audit events.
- **T1.4** ✅ 🔴 Signer infrastructure `[none]` — DONE (PR #2)
  `TreasurySigner` port (contract C1) + Viem wallet-client adapter.
  Fail-closed on absent/malformed key, chain-ID verification before signing,
  `FUNDING_ENABLED` gate flip, `FUNDING_KILL_SWITCH`, wallet client constructed
  only in signing-capable processes; monitor cron still boots with no key.
- **T1.5** ✅ 🔴 Funding dispatch engine `[T1.1, T1.4]` — DONE (PR #8)
  `funding_operations`/`funding_transactions` state machines (contract C4),
  idempotency persisted before submission, per-treasury advisory lock (D7),
  nonce inside the lock, pending-tx-per-wallet check, receipt tracking
  (confirmed/reverted/replaced/dropped), DB-down ⇒ no signing.
- **T1.6** 🔴 `POST /v1/wallets/{id}/ensure-funded` `[T1.2, T1.3, T1.5]`
  Fresh balance read, top-up calc, reserve + max-top-up re-checked immediately
  before signing, idempotency-key handling, before/target/transfer response.
- **T1.7** 🟢 Funding history API + dashboard `[T1.5]`
  `GET /v1/funding-transactions` with filters + pagination, explorer links,
  dashboard table incl. failed/abandoned.
- **T1.8** 🟢 Reserve-exhaustion alert email `[T1.5, T3.1]`
  Critical email when legitimate demand rejected for reserve; alert row dedupe.
- **T1.9** 🔴 Concurrency integration tests `[T1.5, T1.6]`
  Real-Postgres tests: parallel ensure-funded, lock expiry/crash recovery,
  idempotency replay, pending-tx dedupe.

### Phase 2 — Projects, environments, readiness

- **T2.1** 🟢 Projects/environments APIs + scoped authz `[T1.1]`
  CRUD per PRD P2-US1, project-service credentials scoped to
  project/environment, deny-by-default, disable-without-delete.
- **T2.2** 🔴 `POST /v1/environments/{id}/ensure-ready` `[T1.6, T2.1]`
  Orchestrates all startup wallets: parallel reads, serialized dispatch,
  per-wallet no-op/funded/pending/warning/blocked, overall
  ready/degraded/pending/blocked, idempotency key, concurrent-request safety.
- **T2.3** 🔴 Confirmation wait + status resume `[T1.5]`
  Configurable confirmations/timeout (D4), timeout ⇒ `pending`,
  `GET /v1/funding-operations/{id}` resumes tracking, replaced/reverted explicit.
- **T2.4** 🟢 Dashboard: projects/environments/wallets/policy views `[T2.1, T1.7]`

### Phase 3 — Treasury monitoring and email alerts

- **T3.1** 🔄 🔴 Alert state machine domain `[T1.1]` — IN PROGRESS
  Pure `src/domain/alerts/` (contract C3): healthy→warning→critical,
  exactly-one email per transition, reminder interval, recovery resolution.
  Injected clock. Exhaustive unit tests.
- **T3.2** 🟢 Email templates `[none]`
  Warning, critical, reminder, recovery, reserve-blocked, reconciliation-failure
  per PRD §12.3 (chain, address, balance, threshold, action, dashboard link).
- **T3.3** 🔴 Treasury monitor cron alert integration `[T3.1, T3.2]`
  Cron drives transitions + sends emails, persists alert state, manual
  protected check-now stays read-only, no signing key in this process.
- **T3.4** 🟢 Runbooks `[T3.3]`
  All ten PRD §19 runbooks in `docs/runbooks/`.

### Phase 4 — Managed-wallet reconciliation

- **T4.1** 🔴 Reconciliation use case `[T1.5, T1.6]`
  Load enabled+eligible wallets, fresh reads, top-up below-minimum only,
  stop at reserve, run-level summary row.
- **T4.2** 🟢 Reconciler cron entry + Render blueprint `[T4.1]`
  `src/jobs/wallet-reconciler.ts`, every-6h cron in `render.yaml`, separate
  signing secret group, pool closed on exit.
- **T4.3** 🟢 Reconciliation failure alerting `[T4.1, T3.1, T3.2]`
  Consecutive-failure threshold (D8 table), affected wallets + error categories,
  recovery recorded after success.
- **T4.4** 🔴 Cron-vs-API concurrency e2e `[T4.2, T2.2]`
  Reconciler and ensure-ready racing the same treasury: no duplicate transfers,
  no nonce conflicts.

### Cross-cutting

- **TX.1** 🟢 CI hardening `[none]` — secret scan, `npm audit` gate, migration validation job.
- **TX.2** 🟢 API hardening `[none]` — rate limits (needs D8 approval), CORS deny-by-default, security headers.
- **TX.3** 🟢 Docs/README per phase `[rolling]`.

## Suggested wave order

1. **Wave 1 (parallel):** T1.1, T1.2, T1.4, T3.2, TX.1
2. **Wave 2:** T1.3, T1.5, T3.1, T2.1, TX.2
3. **Wave 3:** T1.6, T2.3, T3.3, T1.7
4. **Wave 4:** T2.2, T1.8, T1.9, T3.4, T2.4
5. **Wave 5:** T4.1 → T4.2/T4.3 → T4.4, TX.3
