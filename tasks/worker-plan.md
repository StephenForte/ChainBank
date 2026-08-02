# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting, and must
follow the **[commit and merge contract](#commit-and-merge-contract)** below — it
governs the branch to work in, which files may be touched, the commit convention, and
the report handed back on completion.

## Status (updated 2026-08-02, Wave 5c in review)

`main` is at **407 unit tests plus 75 integration tests** (both counts re-run by the
planner against `origin/main` on 2026-08-02 — the previous 365/64 figure was stale),
with CI (format, lint, typecheck, unit, build, audit, secret scan, migration
validation) green on every PR.

**One open PR: #44 (TX.9), changes requested.** No stale branches.

| Task                                                         | Status      | Landed in                  |
| ------------------------------------------------------------ | ----------- | -------------------------- |
| T1.1 schema + migration `0001`                               | ✅ done     | PR #2                      |
| T1.2 funding math domain                                     | ✅ done     | PR #2                      |
| T1.3 wallet registration + policy APIs                       | ✅ done     | PR #7                      |
| T1.4 signer infrastructure                                   | ✅ done     | PR #2                      |
| T1.5 funding dispatch engine                                 | ✅ done     | PR #8                      |
| T1.6 `ensure-funded` endpoint                                | ✅ done     | PR #13                     |
| T1.7 funding history API + dashboard                         | ✅ done     | PR #11                     |
| T1.8 reserve-exhaustion email                                | ✅ done     | PR #21                     |
| T2.1 projects/environments + scoped authz (migration `0002`) | ✅ done     | PR #7                      |
| T2.3 operation status + confirmation resume                  | ✅ done     | PR #10                     |
| T2.4 dashboard project/environment/wallet/policy views       | ✅ done     | PR #20                     |
| T3.1 alert state machine                                     | ✅ done     | PR #5                      |
| T3.2 email templates                                         | ✅ done     | PR #6                      |
| T3.3 alert persistence + cron/manual orchestration           | ✅ done     | PR #12                     |
| T3.4 operational runbooks (PRD §19)                          | ✅ done     | PR #14                     |
| TX.1 CI pipeline                                             | ✅ done     | PR #4, fixed in #9         |
| TX.2 API hardening (helmet, CORS, rate limit)                | ✅ done     | Phase 0 + PR #13           |
| TX.4 credential list / disable / revoke / enable             | ✅ done     | PR #16, #17                |
| TX.6 alert lookup filtered by alert type                     | ✅ done     | PR #15                     |
| T1.9 concurrency integration tests                           | ✅ done     | PR #35                     |
| T2.2 `ensure-ready` endpoint (contract C11)                  | ✅ done     | PR #33                     |
| TX.5 treasury row lifecycle + ambiguity guard (C12)          | ✅ done     | PR #32                     |
| TX.7 list-environments route (C13)                           | ✅ done     | PR #34                     |
| TX.8 confirm-outside-lock race fix (C7 amendment)            | ✅ done     | PR #37                     |
| TX.3 docs refresh (README + PRD §25)                         | ✅ done     | PR #39                     |
| T4.1 reconciliation use case (C14, migration `0004`)         | ✅ done     | PR #40                     |
| T4.2 reconciler cron entry + Render blueprint                | ✅ done     | PR #41                     |
| T4.3 reconciliation failure alerting (C15)                   | ✅ done     | PR #42                     |
| TX.9 outgoing-scan defects (C14 amendment, migration `0005`) | 🔄 review   | PR #44 — changes requested |
| Remaining: T4.4 (last task in Phase 4)                       | not started | —                          |

Also merged: pagination query-schema fix (#18), hosted-deployment verification
runbook (#22), dashboard troubleshooting notes (#19), and treasury key
generation / wallet-role documentation (#27).

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

**Funding is LIVE (armed 2026-08-01).** Every pre-arming item closed: TX.5 shipped
the treasury lifecycle endpoint and ambiguity guard, the stray Phase 4 treasury row
was disabled through it, and the kill switch was released. Hosted verification
passed all four phases (see `docs/runbooks/verify-hosted-deployment.md`, including
the two documentation errors the live run disproved).

**Current hosted state:** `FUNDING_ENABLED=true`, `FUNDING_KILL_SWITCH=false` —
funding armed and serving. The emergency stop is
`docs/runbooks/disable-all-automated-funding.md`.

**Defects found by T1.9** (corroborating a T2.2 caveat; recorded in the
`tasks/DECISIONS.md` log, 2026-08-01):

1. ✅ **Confirm-outside-lock race — FIXED by TX.8 (PR #37, merged 2026-08-01).**
   Balances were read outside the advisory lock; a fast confirmation let a second
   distinct-key request submit a transfer from a stale read. `dispatchFunding` now
   re-reads wallet and treasury balances inside the lock and recomputes the
   top-up/reserve decision from the fresh values (C7 amendment). The accepted risk
   recorded at arming time is closed once this deploys.
2. **Crash-after-broadcast gap (folded into T4.1) — open.** A backend killed mid-send
   rolls back the in-lock rows: the operation stays `pending`, the wallet is NOT
   wedged, and a transfer that reached the network leaves no DB trace and no
   recorded nonce. Row-based reconciliation cannot find it; T4.1 must compare
   on-chain treasury transactions against expected state, not only resolve stored
   `submission_unknown` rows.

### Next wave

✅ **Wave 5a complete:** TX.8 (#37), T4.1 (#40, C14), TX.3 (#39).
✅ **Wave 5b complete:** T4.2 (#41) and T4.3 (#42, C15) merged — the reconciler cron
is deployed on Render and has completed live runs.
**Wave 5c (now):** **TX.9** 🔴 is in review as PR #44 with **changes requested** —
see the review outcome in the Cross-cutting entry. **T4.4** 🔴 cron-vs-API
concurrency is prompted and ready to dispatch, but **blocked on TX.9 merging**
because it must assert TX.9's corrected scan shape. **D6 has been reconfirmed and
superseded** (2026-08-02) — details in the T4.4 entry. Phase 4 exits with T4.4.

**Live-operation status (2026-08-02):** the reconciler runs on Render every 6
hours with the signing key, and reaches the funding gate correctly. It has **not
yet completed a run with `FUNDING_ENABLED=true`** — runs at the default lookback
exceed practical runtime and were cancelled (TX.9 defect 1). Lower
`RECONCILE_OUTGOING_LOOKBACK_BLOCKS` before trusting the schedule.

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
- **Interface contract numbers:** if your prompt pre-assigns a number, **that
  assignment overrides everything else** — use it even if the file's highest
  number suggests otherwise; the planner reserves numbers across in-flight tasks.
  Only when no number was pre-assigned: grep the file for the highest existing
  number and take the next one. (Two workers both published a "C5" and one had to
  be renumbered during a rebase; in Wave 4 a worker grepped its way to "C11"
  despite a pre-assigned C12, colliding with another in-flight task's
  pre-assignment.)
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
- **T1.8** ✅ 🟢 Reserve-exhaustion alert email `[T1.5, T3.1, T3.2]` — DONE (PR #21)
  Treasury-scoped `treasury_reserve` critical alert on `FUNDING_BLOCKED_RESERVE`,
  persist-then-send dedupe, resolves on the next successful transfer for that
  treasury (contract C10). Hosted Phase 2 confirmed the alert lifecycle against
  real traffic — see `docs/runbooks/verify-hosted-deployment.md`.
- **T1.9** ✅ 🔴 Concurrency integration tests `[T1.5, T1.6]` — DONE (PR #35)
  Parallel ensure-funded, crash recovery via `pg_terminate_backend`, idempotency
  replay + cross-wallet namespacing, pending-tx dedupe across all three C4
  in-flight states, reserve in-flight accounting under parallelism — all with
  deterministic gating and signer-call-count assertions. Confirmed two defects
  now carried into Wave 5: the confirm-outside-lock race (**TX.8**) and the
  crash-after-broadcast reconciliation gap (folded into **T4.1**).

### Phase 2 — Projects, environments, readiness

- **T2.1** ✅ 🟢 Projects/environments APIs + scoped authz `[T1.1]` — DONE (PR #7)
  CRUD per P2-US1, `api_credential_scopes` (migration `0002`, D10),
  `authorizeScope` (contract C6), deny-by-default, disable-without-delete.
- **T2.2** ✅ 🔴 `POST /v1/environments/{id}/ensure-ready` `[T1.6, T2.1]` — DONE (PR #33)
  Composes `ensureWalletFunded` per enabled wallet (contract C11): per-wallet
  no-op/funded/pending/warning/blocked mapped by `criticalAtStartup`, overall
  blocked > degraded > pending > ready, env-level idempotency key namespaced per
  wallet, concurrency and reserve-burst covered by integration tests asserting
  signer call counts.
- **T2.3** ✅ 🔴 Confirmation wait + status resume `[T1.5]` — DONE (PR #10)
  Configurable confirmations/timeout (D4), timeout ⇒ `pending`,
  `GET /v1/funding-operations/{id}` resumes tracking, replaced/reverted explicit,
  `submission_unknown` surfaced as pending with `submission-unconfirmed`
  (contract C8).
- **T2.4** ✅ 🟢 Dashboard: projects/environments/wallets/policy views `[T2.1, T1.7]` — DONE (PR #20)
  Projects, environments, managed wallets, and funding policy editing, with
  BigInt-only wei handling and per-panel independent loading (the previous
  `Promise.all` refresh meant one failing endpoint blanked every panel).
  Surfaced an API gap now tracked as **TX.7**: environments can only be
  discovered through their wallets, so an environment with none is invisible.

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

- **T4.1** 🔴 Reconciliation use case `[T1.5, T1.6]` — contract **C14** (pre-assigned)
  Load enabled+eligible wallets, fresh reads, top-up below-minimum only, stop at
  reserve, run-level summary row. **Also owns:** resolving `submission_unknown` rows
  by searching the treasury's transactions at the recorded nonce (T1.5 review
  follow-up), **and** — scope widened 2026-08-01 after T1.9's crash-recovery
  findings — detecting broadcast transfers with **no DB trace at all**: a backend
  killed mid-send rolls back the in-lock rows, so reconciliation must compare the
  treasury's on-chain outgoing transactions against expected state (recorded
  hashes + nonce continuity), not only resolve stored rows. An on-chain transfer
  from the treasury that no `funding_transactions` row explains is a critical
  finding (possible key compromise or a crash-orphaned send) and must be surfaced,
  never silently adopted.
- **T4.2** 🟢 Reconciler cron entry + Render blueprint `[T4.1]`
  `src/jobs/wallet-reconciler.ts`, every-6h cron in `render.yaml`, separate signing
  secret group, pool closed on exit.
- **T4.3** 🟢 Reconciliation failure alerting `[T4.1, T3.1, T3.2]`
  Consecutive-failure threshold, affected wallets + error categories, recovery
  recorded after success. Template already exists.
- **T4.4** 🔴 Cron-vs-API concurrency tests `[T4.2, T2.2, TX.8, TX.9]` — contract
  **C16** (pre-assigned). **Prompted 2026-08-02; blocked on TX.9 merging.**
  Reconciler and ensure-ready racing the same treasury: no duplicate transfers,
  no nonce conflicts. Depends on TX.8 so the tests lock in the fixed
  read-inside-lock behavior rather than encoding the race, and on TX.9 so they
  assert the corrected scan/watermark shape rather than the shipped one.
  Test-only: the worker may not change `src/` — a defect it finds is reported and
  becomes its own task, not fixed in scope.

  **D6 reconfirmed and superseded (2026-08-02).** D6 provisionally chose Anvil
  for e2e, "spawned only if present on `PATH`, suite skips otherwise," to be
  reconfirmed when T4.4 started. It does not stand as written, for two verified
  reasons: (1) `.github/workflows/ci.yml` runs `npm run test:integration` and
  **never** `npm run test:e2e`, and `test/e2e/` holds only a placeholder — so an
  Anvil suite would run nowhere in CI; (2) combined with the skip clause, the
  Phase 4 exit criterion "API and cron concurrency tests pass" would be satisfied
  by a suite that reports green by skipping — the same silence-looks-like-success
  failure TX.9 exists to fix. T4.4 therefore lands in `test/integration/` against
  real Postgres advisory locks (where the serialization actually happens) with a
  mocked JSON-RPC chain, which CI does run. The one property a mock loses —
  node-level rejection of a reused nonce — is bought back by a nonce-rejecting
  signer fake (C16), so a duplicate-nonce dispatch fails loudly. A real-chain
  Anvil harness is **deferred, not dropped**; schedule it if Phase 5 needs it.
  D6's answer cell is updated in place — not renumbered, no D11.

### Cross-cutting

- **TX.8** ✅ 🔴 Close the confirm-outside-lock funding race `[T1.5, T1.6]` — DONE
  (PR #37); amended contract **C7** (no new number)
  The race proven by T1.9 is closed: `dispatchFunding` re-reads wallet and
  treasury balances **inside** the advisory lock (after wallet re-resolution and
  the pending-tx gate) and recomputes `calculateTopUp` / spendable reserve from
  those fresh values plus the in-flight sum (AGENTS.md §7.3). In-lock read
  failures are terminal pre-broadcast — the operation is marked `failed` before
  any `funding_transactions` row exists, so `RPC_UNAVAILABLE` keeps its ambiguous
  post-broadcast meaning (C4). The previously-impossible test now passes:
  parallel distinct keys with an instant-confirm tracker → exactly one transfer.

- **TX.9** 🔴 Make the treasury outgoing scan usable in production `[T4.1, T4.2]`
  — amends contract **C14** (no new number)
  Found operating the reconciler live on 2026-08-01/02, after T4.2 wired the
  cron. Four defects, all in the crash-orphan / `submission_unknown` scan path.
  **The first is the blocker: the feature as shipped cannot complete a run at
  its own default setting.**
  1. **The scan is O(lookback) RPC round trips.** `scanOutgoingWindow`
     (`src/infrastructure/evm/treasury-outgoing-scanner.ts`) walks the window one
     block at a time via `getBlock({ includeTransactions: true })`, 8 concurrent.
     At the default `RECONCILE_OUTGOING_LOOKBACK_BLOCKS=20000` that is 2,500
     sequential batches pulling full transaction bodies; observed live, runs
     exceeded 5–10 minutes and had to be cancelled. Public RPC rate limiting plus
     the built-in retries make it worse. Fix: scan **incrementally from the last
     successfully-scanned block** (persist it on `reconciliation_runs`; needs a
     migration) so coverage is continuous and cost is proportional to elapsed
     time, not to a guessed constant. A fixed lookback is only a fallback for the
     first run or after a gap.
  2. **`outgoingScanStatus` reports `'complete'` when no scan ran.** It
     initialises to `'complete'` (`reconcile-wallets.ts` ~line 141) and is
     persisted unchanged when the run exits early — a policy-disabled run
     recorded a complete scan it never performed. Any early-exit path must
     record `'not-run'` (new value, or reuse `'incomplete'`) so a run row never
     asserts a check that did not happen. This is the "silence looks like
     success" failure the scan exists to prevent.
  3. **A deliberate policy stop logs as an error.** `reconcile-wallets.ts` ~line
     265 catches `FUNDING_DISABLED` and emits `level: error`,
     `event: reconciliation.run.failed`, `msg: "Reconciliation run failed"` —
     while the job correctly classifies it `policy-disabled` and exits 0. Flipping
     the kill switch therefore produces an ERROR line claiming failure every six
     hours, and AGENTS.md §11 mandates alerting on repeated cron failures. Log
     policy refusals at `info`/`warn` with a distinct event name; reserve
     `reconciliation.run.failed` for genuine malfunction. Keep the exit-code
     classification T4.2 built — it is already correct.
  4. **A long scan emits no progress output.** Operating it live, there was no
     way to distinguish "scanning" from "hung" — the run logs nothing between
     start and finish. Log periodic progress (blocks scanned / window remaining)
     so an operator can tell the difference.
     Deliver 1 and 2 together (both touch scan bookkeeping); 3 and 4 are small and
     independent. Cover with tests: incremental resume from a stored block, first-run
     fallback, gap after a missed run, early-exit scan status, policy-refusal log
     level, and that a scan failure still fails closed to `incomplete` (never a clean
     empty report). **Do not weaken the fail-closed rules T4.1 established** — an
     unexplained on-chain transfer stays a critical finding.
     **Operator note:** until this lands, set `RECONCILE_OUTGOING_LOOKBACK_BLOCKS`
     low enough to finish (~2500 covers one 6-hour interval on Sepolia with margin;
     lower still for smoke tests). A short lookback means a missed or failed run
     leaves an unscanned gap, and `submission_unknown` rows older than the window
     correctly stay pending rather than settling.

  **Review outcome (planner, 2026-08-02) — PR #44, changes requested.** Branch was
  correctly based on current `origin/main` (no rebase needed — first time in four).
  Full gate re-run locally and green: format/lint/typecheck/build, 423 unit, 77
  integration against a scratch Postgres. Migration `0005` proved forward from
  `0004` on **populated** data (seeded treasury + finished and aborted run rows);
  a full `information_schema` dump of forward-from-`0004` is byte-identical to a
  fresh apply. Defects 2, 3 and 4 are correctly fixed — and better than asked on
  2, since `insertStarted` takes the new `'not-run'` column default, so even a
  hard-killed run no longer leaves a false `'complete'`. Policy logging touched
  neither exit codes nor C15's `FUNDING_DISABLED`-is-neutral rule; boot upsert
  does not clobber the watermark (verified in code and integration test);
  `findOutgoingByNonce` still leaves rows pending on a miss. Watermark on
  `treasuries` rather than `reconciliation_runs` is a better call than this entry
  specified — the scan is per-treasury — and is accepted.

  Three things must change before merge:
  1. **Blocking — marker advancement is inverted for gap > cap.**
     `planOutgoingScanWindow` scans the most recent cap-worth and sets
     `advanceMarkerTo: tip`, so `[marker+1, tip-cap-1]` is skipped and becomes
     permanently unreachable, while the run still records
     `outgoing_scan_status: 'complete'`. Proved with a probe: a crash-orphaned
     transfer at block 5 000 (marker 1 000, tip 50 000, cap 20 000) is never
     reported, in that run or any later one, and the run reads clean. The
     `outgoing_scan_coverage_behind` finding fires exactly once at `warning` and
     is then unreproducible, so nothing carries the signal forward. Fix:
     forward-contiguous window `[M+1, min(M+C, T)]` advancing to `min(M+C, T)`,
     and report `'incomplete'` while a backlog remains (C15 already makes
     `incomplete` non-paging, so this adds no alert noise).
  2. **Defect 1 is only half-fixed.** `findOutgoingByNonce` still walks one
     full-body `getBlock` per block: measured 7 457 round trips for a 24h-old
     `submission_unknown` row and 20 001 for an aged one — the exact window that
     had to be cancelled live — and it runs per pending row, serially. So a single
     aged row reintroduces the blocker, and this PR's operator note (restore
     `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` to 20000) is what would trigger it. Fix:
     bisect on `eth_getTransactionCount` at block height (monotonic, ~15 probes
     instead of 20 001), or split it out as its own task and correct the operator
     note.
  3. **Watermark is advanced before findings are durable.**
     `recordOutgoingScanComplete` runs inside the treasury loop; the findings it
     produced are only persisted later by `markFinished`, after the whole wallet
     sweep. A kill in between — the crash class this detection exists for —
     durably advances the marker while losing a possible key-compromise finding.
     Fix: flush watermark advances after `markFinished` succeeds.

  Minor, also requested: zero enabled treasuries records a vacuous `'complete'`;
  the `wallet-reconciler.ts` comment claims `finished_at IS NULL` is authoritative
  but that misses finished pre-`0005` rows still reading `'complete'`; reorgs
  (tip < marker) are unhandled and should be a stated C14 limitation.

  `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` stays at its lowered hosted value until
  this lands.

- **TX.1** ✅ 🟢 CI hardening — DONE (PR #4, gitleaks token/permission fixed in PR #9)
  format, lint, typecheck, unit, build, `npm audit`, gitleaks, migration validation
  - integration tests against a Postgres service container. Actions pinned by SHA.
- **TX.2** ✅ 🟢 API hardening — DONE (Phase 0 bootstrap, corrected in PR #13)
  `@fastify/helmet`, `@fastify/cors` (deny-by-default), and `@fastify/rate-limit`
  are registered in `src/api/app.ts`. D8 was a false blocker — the dependency
  predated the plan. The T1.6 review found the rate limiter's credential key was
  dead code and proxy trust was unbounded; both are fixed.
- **TX.3** 🟢 Docs/README per phase `[rolling]` — **refresh due (Wave 5a)**
  Last refreshed 2026-07-29; T2.2, TX.5, TX.7, and T1.9 have landed since and
  funding is armed in production. Bring README and the PRD implementation
  appendix (§25) to merged state: `ensure-ready` (C11), treasury lifecycle (C12),
  list-environments (C13), the armed hosted state, and the two known defects
  carried into Wave 5. This plan itself is planner-maintained — do not edit it.

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
  to the **old** row.
  **Two distinct failure modes — corrected 2026-08-01 after live testing proved
  the first one:**
  - **Changing `TREASURY_ADDRESS` alone is a silent no-op.** The old row still
    matches the unchanged signing key, so `assertSignerMatchesTreasury` passes and
    funding proceeds normally against the **old** treasury. No error, no warning —
    the operator believes the treasury moved and it did not. This was previously
    documented here as failing closed; it does not. Confirmed during hosted
    Phase 4 verification, where a deliberately mismatched `TREASURY_ADDRESS`
    still produced a successful 0.05 ETH transfer from the original treasury.
  - **Changing both address and key** does fail closed with
    `INVALID_CONFIGURATION`, because the new key then mismatches the still-resolved
    old row.
    The silent case is the more dangerous of the two and should drive the design.
    **Direction decided (2026-08-01, planner):** option (a) — an operator-only
    `PATCH /v1/treasuries/:id { enabled }` — **plus a fail-closed ambiguity guard**
    in `resolveTreasuryForWallet`: more than one enabled treasury row for the
    wallet's chain refuses with `INVALID_CONFIGURATION` before any signer call.
    Option (b) (prefer the signer-matching row) is rejected: it silently
    reinterprets which treasury is authoritative. The guard turns the silent no-op
    into a loud refusal, and rotation becomes: change config → funding refuses →
    disable the retired row via the endpoint → funding resumes on the new row.
    Reserve accounting, nonce probing, and alert entity ids all key off the resolved
    row, so verify each still describes the intended treasury afterward.
    **Acceptance criteria (added 2026-08-01 after the live run):**
  - The hosted Phase 4 wrong-key scenario must become fail-closed in its
    address-only form: with two enabled rows for one chain — the state the live
    run actually created — `ensure-funded` refuses with `INVALID_CONFIGURATION`
    and no signer call is made, regardless of which row the signer matches.
  - An integration test walks the real rotation path end to end: bootstrap upsert
    of a second row → refusal → disable the retired row via the new endpoint →
    funding resolves the remaining row.
  - `docs/runbooks/verify-hosted-deployment.md` (wrong-key step) and
    `rotate-treasury-key.md` are updated to match the new behavior.
    **Deployment note:** the Phase 4 wrong-key experiment left a second enabled
    `treasuries` row (the temporary address) in the hosted database. Deploying
    TX.5's guard will therefore refuse funding until it is cleaned up — harmless
    while the kill switch is on. Rollout order: deploy TX.5 → disable the stray row
    via the new endpoint → release the kill switch.

### Prerequisite refactor for multi-type alerting (complete)

- **TX.6** ✅ 🟢 Filter alert lookups by alert type `[none]` — DONE (PR #15)
  `AlertRepository.findOpenByEntity` previously matched on entity and
  `state='open'` only, ignoring `alert_type`. T3.3's balance alerts occupy
  entityType `'treasury'` with the treasury id, so a second alert type on that
  entity would have collided with them — the treasury monitor could have
  escalated or resolved a reserve alert believing it held the balance alert,
  silently breaking the exactly-once email semantics P3-US2 requires.
  `findOpenByEntity` now takes an explicit `alertType` (contract C3a); T3.3's
  alert tests were kept passing unchanged as evidence balance-alert behavior did
  not move. This was landed deliberately **before** T1.8, since T1.8 is exactly
  the second alert type the fix anticipated — see T1.8's entry above and
  `tasks/DECISIONS.md` contract C10. T4.3 (reconciliation-failure alerts)
  inherits the fix for free when it lands.

### API gap surfaced by the dashboard

- **TX.7** 🟢 List environments for a project `[none]`
  There is no route to list a project's environments. `POST /v1/projects/:id/environments`
  creates one and `GET /v1/environments/:id` fetches a known one, but nothing
  enumerates them. T2.4's dashboard therefore discovers environments by reading
  `GET /v1/wallets?projectId=`, which means **an environment with zero wallets is
  invisible** — exactly the state a freshly created environment is in.
  Deliver `GET /v1/projects/:id/environments`, paginated, mirroring the existing
  list-projects shape.
  Two things to get right rather than re-derive:
  - **Authorization** must match `listProjects` — use `resolveReadableProjectIds`
    / `assertProjectReadPermission` so a project-service credential sees only its
    scoped projects and cannot enumerate environments of projects outside its
    scope. Cover the role matrix in tests.
  - **Pagination** must use the shared helpers in `src/api/pagination.ts`. Query
    values are strings because ajv runs with `coerceTypes: false`; declaring
    `limit` as an integer is what shipped two broken endpoints (PR #18).
    Then update the dashboard to use it and drop the wallet-derived workaround.
    Standalone rather than folded into T2.2 so that task's security review stays
    focused on the money path — but folding it in is reasonable if T2.2 starts first.

## Remaining wave order

1. ✅ **Wave 4 (complete 2026-08-01):** TX.7 (#34) → TX.5 (#32) → T2.2 (#33) →
   T1.9 (#35). Funding armed in production at wave close.
2. ✅ **Wave 5a (complete 2026-08-01):** TX.8 (#37) → T4.1 (#40) → TX.3 (#39).
3. ✅ **Wave 5b (complete 2026-08-01):** T4.2 (#41) → T4.3 (#42, C15).
4. **Wave 5c (now):** TX.9 🔴 (PR #44, changes requested) → T4.4 🔴 cron-vs-API
   concurrency (C16, prompted and held until TX.9 merges). Phase 4 exits here.

Merge-order cautions for Wave 5:

- **TX.9 before T4.4 — still binding, and now concrete.** T4.4 asserts the window
  arithmetic `[M+1, min(M+C, T)]` advancing to `min(M+C, T)`, status `'complete'`
  only when the window reaches the tip. That is the _corrected_ TX.9 shape, not
  what PR #44 currently does. The T4.4 prompt instructs the worker to stop and
  report `blocked` if it finds tip-facing windows on `main` — so a TX.9 merged
  without review item 1 will visibly halt T4.4 rather than get quietly encoded.
- ✅ **TX.9 and T4.3 both edit `reconcile-wallets.ts`** — resolved as planned:
  T4.3 landed first (#42) and TX.9 built on it. Verified at review that TX.9's
  policy-logging change did not disturb C15's `FUNDING_DISABLED`-is-neutral rule
  or the T4.2 exit-code classification.
- **D6 is settled (2026-08-02) — no longer a T4.4 prerequisite.** Reconfirmed and
  superseded: T4.4 goes in the integration suite, not Anvil e2e. Reasoning in the
  T4.4 entry above; the deciding fact is that CI never runs `test:e2e`.
- TX.3 is docs-only and safe at any time; merge it last in 5a so it can record
  whatever 5a lands.

**Before arming funding in a hosted environment (updated 2026-08-01):**

- ✅ T3.4 runbooks (PR #14).
- ✅ D3 thresholds — final values warning 0.75 / critical 0.3 / recovery 1.5 /
  reserve 0.1 ETH, declared as literal `value:` entries in `render.yaml` (not
  dashboard-set), reserve strictly below critical so the critical alert cannot be
  stranded. CI validates the ladder before it can reach a service
  (`test/unit/config/render-blueprint-thresholds.test.ts`), and the runtime
  validator enforces `reserve < critical` everywhere, not just the declared config.
  See the D3 detail note in `tasks/DECISIONS.md`.
- ✅ T1.8 — reserve-exhaustion critical email (PR #21). Closes the gap between the
  warning email and a funding request silently failing with
  `FUNDING_BLOCKED_RESERVE`.
- ✅ TX.4 — credential list / disable / revoke / enable (PR #16, #17, #27), so
  incident response no longer needs SQL.
- ✅ `render.yaml` gap fixed — `FUNDING_KILL_SWITCH` (default `false`) and
  `TRUSTED_PROXY_HOPS` (`1`) are now declared in the Blueprint, so the emergency
  stop is flipping an existing value rather than creating one under pressure.
- ✅ TX.5 — treasury row lifecycle (PR #32). `PATCH /v1/treasuries/:id { enabled }`
  plus the fail-closed ambiguity guard: an address-only `TREASURY_ADDRESS` change
  (the silent no-op proven in hosted Phase 4) now refuses with
  `INVALID_CONFIGURATION` until the retired row is disabled through the API.
  Rotation no longer needs SQL — see `docs/runbooks/rotate-treasury-key.md`.
- ✅ **Hosted verification complete** (2026-08-01). All four phases passed against
  the live Render deployment, including a real 0.05 ETH Sepolia transfer
  (independently verified on-chain), idempotent replay, and the kill switch
  refusing under live conditions. See `docs/runbooks/verify-hosted-deployment.md`.

**Checklist closed — funding armed 2026-08-01.** The stray Phase 4 treasury row
was disabled via the TX.5 endpoint and `FUNDING_KILL_SWITCH` set to `false`. The
list above is retained as the record of what arming required. The one risk
accepted at arming time — the confirm-outside-lock race (bounded overshoot,
narrow real-chain window) — was closed by TX.8 (PR #37, merged 2026-08-01); see
the defect list at the top of this document.
