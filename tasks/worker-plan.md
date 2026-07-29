# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting.

## Status (updated 2026-07-29)

**Waves 1–3 are all merged to `main`.** No open PRs, no stale branches. `main` is at
262 unit tests across 35 files plus 40 integration tests, with CI (format, lint,
typecheck, unit, build, audit, secret scan, migration validation) green on every PR.

| Task                                                         | Status      | Landed in          |
| ------------------------------------------------------------ | ----------- | ------------------ |
| T1.1 schema + migration `0001`                               | ✅ done     | PR #2              |
| T1.2 funding math domain                                     | ✅ done     | PR #2              |
| T1.3 wallet registration + policy APIs                       | ✅ done     | PR #7              |
| T1.4 signer infrastructure                                   | ✅ done     | PR #2              |
| T1.5 funding dispatch engine                                 | ✅ done     | PR #8              |
| T1.6 `ensure-funded` endpoint                                | ✅ done     | PR #13             |
| T1.7 funding history API + dashboard                         | ✅ done     | PR #11             |
| T2.1 projects/environments + scoped authz (migration `0002`) | ✅ done     | PR #7              |
| T2.3 operation status + confirmation resume                  | ✅ done     | PR #10             |
| T3.1 alert state machine                                     | ✅ done     | PR #5              |
| T3.2 email templates                                         | ✅ done     | PR #6              |
| T3.3 alert persistence + cron/manual orchestration           | ✅ done     | PR #12             |
| TX.1 CI pipeline                                             | ✅ done     | PR #4, fixed in #9 |
| TX.2 API hardening (helmet, CORS, rate limit)                | ✅ done     | Phase 0 + PR #13   |
| Remaining: T1.8, T1.9, T2.2, T2.4, T3.4, all of Phase 4      | not started | —                  |

**Phase 1 is functionally complete.** Two security reviews ran on the money path and
both produced fixes that shipped before merge:

- `tasks/SECURITY-REVIEW-T1.5.md` — in-flight transfers now count against the
  reserve; ambiguous submissions record non-terminal `submission_unknown`
  (migration `0003`); receipt classification requires positive evidence.
- `tasks/SECURITY-REVIEW-T1.6.md` — rate limiting now actually engages (the
  credential key was dead code at `onRequest`); `TRUSTED_PROXY_HOPS` replaces
  blanket proxy trust so `X-Forwarded-For` cannot forge `request.ip`; the signing
  key is asserted to match the reserve-enforced treasury row; idempotency keys are
  namespaced per wallet.

**Funding is reachable but disabled.** `FUNDING_ENABLED` must stay `false` until the
runbooks in T3.4 exist — that is the §20 blocking item, not a preference.

### Next wave (all unblocked, run in parallel)

**T3.4** 🟢 runbooks — highest value, it unblocks ever enabling funding.
**T2.2** 🔴 `ensure-ready`, **T1.8** 🟢 reserve-exhaustion email, **T1.9** 🔴
concurrency tests, **T2.4** 🟢 dashboard views. Then Phase 4.

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
- **T1.6** ✅ 🔴 `POST /v1/wallets/{id}/ensure-funded` `[T1.2, T1.3, T1.5]` — DONE (PR #13)
  Fresh balance reads, reserve + max-top-up re-checked under the lock, required
  idempotency key, before/target/transfer response. The destination-allowlist
  mandate was satisfied by removing the address from the dispatch contract
  entirely: `dispatchFunding` takes only `walletId` and re-resolves the row inside
  the advisory lock. Security-reviewed; see `tasks/SECURITY-REVIEW-T1.6.md`.
- **T1.7** ✅ 🟢 Funding history API + dashboard `[T1.5]` — DONE (PR #11)
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
- **T2.3** ✅ 🔴 Confirmation wait + status resume `[T1.5]` — DONE (PR #10)
  Configurable confirmations/timeout (D4), timeout ⇒ `pending`,
  `GET /v1/funding-operations/{id}` resumes tracking, replaced/reverted explicit,
  `submission_unknown` surfaced as pending with `submission-unconfirmed`
  (contract C8).
- **T2.4** 🟢 Dashboard: projects/environments/wallets/policy views `[T2.1, T1.7]`
  The dashboard now has treasury status, readiness, and funding history; project,
  environment, wallet, and policy views remain.

### Phase 3 — Treasury monitoring and email alerts

- **T3.1** ✅ 🔴 Alert state machine domain `[T1.1]` — DONE (PR #5)
  Pure `src/domain/alerts/` (contract C3), injected clock, exhaustive tests.
- **T3.2** ✅ 🟢 Email templates `[none]` — DONE (PR #6)
  Six operator templates per PRD §12.3 plus the pre-existing test message.
- **T3.3** ✅ 🔴 Treasury monitor cron alert integration `[T3.1, T3.2]` — DONE
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
- **TX.2** ✅ 🟢 API hardening — DONE (Phase 0 bootstrap, corrected in PR #13)
  `@fastify/helmet`, `@fastify/cors` (deny-by-default), and `@fastify/rate-limit`
  are registered in `src/api/app.ts`. D8 was a false blocker — the dependency
  predated the plan. The T1.6 review found the rate limiter's credential key was
  dead code and proxy trust was unbounded; both are fixed.
- **TX.3** ✅ 🟢 Docs/README per phase `[rolling]` — current as of 2026-07-29
  README, PRD implementation appendix (§25), and this plan reflect merged state.
  Refresh again when T2.2 or Phase 4 lands.

## Remaining wave order

1. **Wave 4 (now):** T3.4 🟢 first — runbooks are the §20 gate on ever enabling
   funding. In parallel: T2.2 🔴, T1.8 🟢, T1.9 🔴, T2.4 🟢.
2. **Wave 5:** T4.1 → T4.2 / T4.3 → T4.4.

Merge-order caution for Wave 4: T2.2 (`ensure-ready`) and T1.9 (concurrency tests)
both build on the funding application layer; land T2.2 first so T1.9 can cover it.

Decision D6 (local chain versus mocked JSON-RPC for e2e) must be resolved before
T4.4, and ideally before T1.9.
