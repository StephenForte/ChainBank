# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting, and must
follow the **[commit and merge contract](#commit-and-merge-contract)** below — it
governs the branch to work in, which files may be touched, the commit convention, and
the report handed back on completion.

## Status (updated 2026-07-29)

**Waves 1–3 are all merged to `main`.** No open PRs, no stale branches. `main` is at
262 unit tests across 35 files plus 40 integration tests, with CI (format, lint,
typecheck, unit, build, audit, secret scan, migration validation) green on every PR.

| Task                                                                | Status      | Landed in          |
| ------------------------------------------------------------------- | ----------- | ------------------ |
| T1.1 schema + migration `0001`                                      | ✅ done     | PR #2              |
| T1.2 funding math domain                                            | ✅ done     | PR #2              |
| T1.3 wallet registration + policy APIs                              | ✅ done     | PR #7              |
| T1.4 signer infrastructure                                          | ✅ done     | PR #2              |
| T1.5 funding dispatch engine                                        | ✅ done     | PR #8              |
| T1.6 `ensure-funded` endpoint                                       | ✅ done     | PR #13             |
| T1.7 funding history API + dashboard                                | ✅ done     | PR #11             |
| T2.1 projects/environments + scoped authz (migration `0002`)        | ✅ done     | PR #7              |
| T2.3 operation status + confirmation resume                         | ✅ done     | PR #10             |
| T3.1 alert state machine                                            | ✅ done     | PR #5              |
| T3.2 email templates                                                | ✅ done     | PR #6              |
| T3.3 alert persistence + cron/manual orchestration                  | ✅ done     | PR #12             |
| T3.4 operational runbooks (PRD §19)                                 | ✅ done     | PR #14             |
| TX.1 CI pipeline                                                    | ✅ done     | PR #4, fixed in #9 |
| TX.2 API hardening (helmet, CORS, rate limit)                       | ✅ done     | Phase 0 + PR #13   |
| Remaining: TX.6, T1.8, T1.9, T2.2, T2.4, TX.4, TX.5, all of Phase 4 | not started | —                  |

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

**Funding is reachable but still disabled.** The PRD §19 runbooks now exist, which
was the §20 gate. Writing them surfaced two operability gaps — no credential
revoke tooling and no supported way to complete a treasury key rotation — now
tracked as **TX.4** and **TX.5**. Both fail closed rather than mis-spending, but each
leaves an incident response or a routine rotation dependent on hand-written SQL, so
they belong before `FUNDING_ENABLED=true` in a hosted environment. See the
"Before arming funding" checklist at the end of this document.

### Next wave (all unblocked, run in parallel)

**TX.6** 🟢 alert-lookup filter first (it gates T1.8 — see its entry), then
**T1.8** 🟢 reserve-exhaustion email, **T2.2** 🔴 `ensure-ready`, **T1.9** 🔴
concurrency tests, **T2.4** 🟢 dashboard views, **TX.4** 🟢 credential revoke
tooling, **TX.5** 🔴 treasury row lifecycle. Then Phase 4.

## Commit and merge contract

**Every task in the tree below carries this contract.** It is not optional and it is
not per-task boilerplate to restate — a worker prompt may add task-specific rules,
but never relaxes what follows. Each clause exists because its absence cost real
rework in an earlier wave; the parenthetical notes say which.

### 1. Branch and workspace

- **One task, one branch, one working copy.** Branch from current `origin/main`:
  `git fetch origin && git switch -c <branch> origin/main`.
- **Naming:** `feat/<task-id-lowercase>-<short-slug>` (e.g. `feat/t2.2-ensure-ready`),
  or `fix/<slug>` for defect work.
- **Never work in a checkout another worker is using.** Use a separate clone or
  `git worktree add`. (Wave 2 ran five workers in one checkout; their output landed
  as a single undifferentiated pile of uncommitted changes that had to be split into
  five PRs by hand, with two of them entangled beyond clean separation.)
- **Do not commit to `main`, and do not merge your own PR.** The operator merges.

### 2. What you may touch

Classify every file you are about to edit:

- **Owned** — files this task creates, plus files no other in-flight task lists as
  owned. Edit freely.
- **Shared** — edit only as much as the task genuinely requires, additively, and
  list every shared file you touched in your handoff. These are the ones that
  collide: `src/app/ports.ts`, `src/container.ts`, `src/api/app.ts`,
  `src/domain/errors.ts`, `src/infrastructure/db/schema.ts`,
  `test/support/funding-fakes.ts`, `README.md`, `tasks/DECISIONS.md`.
- **Off-limits without explicit instruction** — `AGENTS.md`, `tasks/ChainBank_PRD_v4.md`
  sections 1–24, `tasks/worker-plan.md`, `.github/workflows/`, `package.json`
  dependencies, and any existing `drizzle/*.sql` migration file. Adding a _new_
  migration is fine; editing a committed one is not.

Specific collision rules:

- **`tasks/DECISIONS.md`:** append your contract and your one-line decision-log
  entry at the very end of their sections. Expect a conflict on rebase and resolve
  it by **keeping both sides** — these are append-only logs, never either/or.
  (Every single rebase this project has done conflicted here.)
- **Interface contract numbers:** before claiming `C<n>`, grep the file for the
  highest existing number and take the next one. (Two workers both published a
  "C5" and one had to be renumbered during a rebase.)
- **Migrations:** run `npm run db:generate` only after rebasing onto latest `main`,
  so your migration number does not collide with one merged while you worked.
- **Never weaken a security check or an existing test to make your change pass**
  (AGENTS.md §1.5). If an existing test encodes behavior you believe is wrong,
  changing it is allowed but must be called out explicitly in the handoff with the
  reasoning. (A T1.5 test asserted `RPC_UNAVAILABLE ⇒ terminal failure`, which was
  itself the bug; the fix legitimately rewrote it — that has to be visible, not
  buried in a diff.)

### 3. Commits

- Imperative subject under ~72 characters, describing the change, not the task id.
- Body explains **why** and names the PRD user story or AGENTS.md section it
  satisfies. Security-relevant reasoning goes here, not only in the PR.
- End every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Never commit secrets, real `.env` files, private keys, or live database URLs —
  not even in a commit you intend to amend away.
- Keep generated build output (`dist/`, `coverage/`) out of the commit.
- Multiple commits are fine; a tidy history is not worth a broken bisect. Do not
  rewrite history that has been pushed and reviewed.

### 4. Before you hand off — the gate

Run all of these from the branch, **after** a final `git fetch origin && git rebase origin/main`:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```

Then, against a scratch database (integration tests are opt-in and CI runs them, so
a failure here is yours to find, not the operator's):

```bash
createdb chainbank_task_check
DATABASE_URL=postgres://localhost:5432/chainbank_task_check \
CHAINBANK_RUN_INTEGRATION=true \
  npm run db:migrate && npm run test:integration
dropdb chainbank_task_check
```

If your task adds a migration, additionally prove it applies **forward from the
previous migration**, not just to an empty database.

The rebase-then-re-run order matters: a text-clean rebase can still break the
build. (T3.3 added an `alerts` repository to the container; T1.6's test stub merged
without conflict and then failed to compile.)

Do not report success with any check skipped or failing. "Tests pass except X" is a
failed gate — say so plainly instead.

### 5. What you hand back

Open a PR against `main` with the AGENTS.md §15 body (problem and phase/user-story
reference, implementation summary, security impact, migration/configuration
changes, tests added, operational and rollback notes). Open it **ready for review,
not as a draft**, unless the work is deliberately incomplete — and if it is, say so
in the title. (Two PRs sat silently as drafts and could not be merged until the
operator noticed.)

Then reply with exactly this report and nothing padded around it:

```text
TASK:        <id and one-line description>
BRANCH:      <branch name>
PR:          <url, or "not opened — reason">
STATUS:      complete | complete-with-caveats | blocked

GATE:        format ✅/❌  lint ✅/❌  typecheck ✅/❌  build ✅/❌
             unit <n> passed  integration <n> passed  (or "not run — reason")
MIGRATION:   <none | number + verified fresh and forward>

SHARED FILES TOUCHED:
  <path> — <what changed, one line each>

CONTRACTS PUBLISHED / CHANGED:
  <C<n> name, or "none">

EXISTING TESTS MODIFIED:
  <path — what changed and why it was not a weakening, or "none">

DECISIONS NEEDED FROM OPERATOR:
  <question, or "none">

RISKS AND FOLLOW-UPS:
  <what you left undone, what a reviewer should look hardest at, or "none">
```

`complete-with-caveats` and `blocked` are respected answers. A worker that stops and
reports an unresolved security question is behaving correctly (AGENTS.md §1.7); one
that guesses and reports success is not.

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

### Operability gaps surfaced by the T3.4 runbooks

Writing the PRD §19 runbooks exposed two capabilities an operator needs that do not
exist. Both are recorded in the Known gaps table in `docs/runbooks/README.md`, and
both should land **before funding is armed in a hosted environment** — not because
either is a security hole (both fail closed) but because each leaves an incident
response or a routine rotation dependent on hand-written SQL.

- **TX.4** 🟢 Credential disable / revoke tooling `[none]`
  `api_credentials` already has `enabled` and `revoked_at`, and
  `authenticateCredential` honors both (`CREDENTIAL_DISABLED`) — but nothing can
  set them. There is no script, no endpoint, and no repository write method, so
  `rotate-service-token.md` and `disable-compromised-project-credential.md` both
  instruct the operator to run SQL during an incident.
  Deliver: a repository method plus either an operator-only endpoint
  (`PATCH /v1/admin/credentials/:id`) or a `npm run credential:revoke` script —
  prefer the endpoint, since the script needs database access the operator may not
  have mid-incident. **Must write an `audit_events` row**: AGENTS.md §7.7 requires
  authorization-relevant changes to be audited, and the SQL workaround does not,
  which is itself a listed gap. Update both runbooks to use the real path and move
  their entries out of Known gaps.
- **TX.5** 🔴 Treasury row lifecycle and resolution `[none]`
  There is no supported way to complete a treasury key rotation. The bootstrap
  upsert conflict target is `(chain_id, address)`, so a new address inserts a new
  `treasuries` row; `listEnabled()` orders by `created_at ASC` and
  `resolveTreasuryForWallet` takes the first chain match, so funding keeps binding
  to the **old** row. Since PR #13 added `assertSignerMatchesTreasury`, the rotated
  key then mismatches the resolved row and funding fails closed with
  `INVALID_CONFIGURATION` until the old row is disabled by hand.
  Decide and implement one of: (a) an operator-only way to disable a treasury row,
  or (b) make resolution prefer the row whose address matches the signer, or (c)
  make the rotation path explicit so an address change retires the previous row.
  Option (b) is the smallest change but silently reinterprets which treasury is
  authoritative — treat that as a money-path decision, publish it in
  `tasks/DECISIONS.md`, and cover it with tests for the two-enabled-rows case.
  Reserve accounting, nonce probing, and alert entity ids all key off the resolved
  row, so verify each still describes the intended treasury afterward.

### Prerequisite refactor for multi-type alerting

- **TX.6** 🟢 Filter alert lookups by alert type `[none]` — **do before T1.8**
  `AlertRepository.findOpenByEntity(entityType, entityId)` matches on entity and
  `state='open'` only, ignoring `alert_type`. T3.3's balance alerts occupy
  entityType `'treasury'` with the treasury id, so the moment a second alert type
  lands on that entity the lookup returns whichever open row triggered most
  recently — and the treasury monitor could escalate or resolve a reserve alert
  believing it holds the balance alert. That silently breaks the exactly-once
  email semantics guaranteed by P3-US2 and a Phase 3 exit criterion.
  `alert_type` is already a first-class column and PRD §7.9 anticipates several
  alert types per entity, so this is a latent defect rather than a design change.
  Deliver: add an explicit alert type to the lookup, update the single `src/`
  call site, keep T3.3's alert tests passing **unchanged** as the evidence that
  balance-alert behavior did not move.
  **Sequencing matters.** Only one alert type exists today
  (`treasury_balance`), so every stored row shares it and adding the filter is
  provably a no-op on current data. Once T1.8 introduces a second type the filter
  becomes load-bearing and that proof is no longer available. Doing this after
  T1.8 would instead mean migrating the entity key on live alert rows — a data
  migration in place of a code change. T4.3 (reconciliation-failure alerts) hits
  the identical wall and inherits the fix for free.
  No migration required: `alerts.alert_type` is `text`, not a Postgres enum.

## Remaining wave order

1. **Wave 4 (now):** **TX.6** 🟢 first and alone — it is small and everything
   alert-shaped waits on it. Then, in parallel: T1.8 🟢 reserve-exhaustion email,
   T2.2 🔴 `ensure-ready`, T1.9 🔴 concurrency tests, T2.4 🟢 dashboard views,
   TX.4 🟢 credential revoke tooling, TX.5 🔴 treasury row lifecycle.
2. **Wave 5:** T4.1 → T4.2 / T4.3 → T4.4.

Merge-order cautions for Wave 4:

- **TX.6 before T1.8**, for the reason in its entry: the refactor is only provably
  behavior-preserving while a single alert type exists.
- T2.2 (`ensure-ready`) and T1.9 (concurrency tests) both build on the funding
  application layer; land T2.2 first so T1.9 can cover it.
- TX.5 changes which treasury row funding resolves to, and T2.2 fans out across many
  wallets against one treasury. Land TX.5 before T2.2 if both are in flight, or
  expect T2.2 to need a rebase and a re-read of its reserve assertions.
- TX.4 is independent of everything else and safe to run at any time.
- T1.8 and T2.2 both add callers that can hit a reserve refusal. Land T1.8 first so
  T2.2 inherits the alerting rather than needing it retrofitted.

Decision D6 (local chain versus mocked JSON-RPC for e2e) must be resolved before
T4.4, and ideally before T1.9.

**Before arming funding in a hosted environment:**

- ✅ T3.4 runbooks (PR #14).
- ✅ D3 thresholds — warning 1 / critical 0.25 / recovery 2 / reserve 0.5 ETH, set in
  the Render environment. See the D3 detail note in `tasks/DECISIONS.md`: the reserve
  sits between critical and warning, so funding halts while status still reads
  `warning` and the critical email is **not** the funding-stopped signal.
- **T1.8** — now higher priority than its 🟢 sizing suggests. With these thresholds
  the only notification between "warning at 1 ETH" and "requests failing with
  `FUNDING_BLOCKED_RESERVE` at 0.5" is the reserve-exhaustion email that T1.8 builds
  (PRD P1-US5). Without it, funding can be silently refusing requests with no new
  operator signal.
- **TX.4 and TX.5** — so credential revocation and treasury key rotation do not
  require hand-written SQL mid-incident.
- **`render.yaml` gap:** `FUNDING_KILL_SWITCH` is not declared in the Blueprint, so
  the emergency-stop runbook currently instructs the operator to _create_ the
  variable under pressure. Pre-declare it as `false` (and `TRUSTED_PROXY_HOPS: 1`,
  which is security-relevant and currently relying on its default) so the emergency
  action is flipping an existing value. Small, do it with T1.8 or TX.4.
- **Hosted verification** — PRD §20 requires it and nothing has done it. Render is
  the host and the Blueprint provisions web + monitor cron + Postgres, but no one has
  smoke-tested the Phase 1–3 paths against a deployed instance: alert transitions and
  a real email, `ensure-funded` end to end on Sepolia with a disposable wallet, the
  kill switch taking effect after restart, and `verify-cron-execution.md`. The
  existing `deploy-render-phase0.md` checklist only covers read-only Phase 0.
  Consider this a task if you want it tracked rather than done by hand.
