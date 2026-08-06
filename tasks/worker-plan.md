# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting, and must
follow the **[commit and merge contract](#commit-and-merge-contract)** below — it
governs the branch to work in, which files may be touched, the commit convention, and
the report handed back on completion.

## Status (updated 2026-08-06 — **PHASE 4 EXITED**; this effort's scope is complete)

`main` is at **464 unit tests plus 92 integration tests, 0 skipped** (both counts
re-run by the planner against `origin/main`), with CI (format, lint,
typecheck, unit, build, audit, secret scan, migration validation) green on every PR.

**No open PRs. Every planned Phase 1–4 task is merged, plus the post-exit operability
wave TX.11–TX.15. No known open defects.** TX.16 is dispatched (2026-08-06) and TX.17 is
open but not dispatched — both are post-exit operability, not Phase 1–4 scope.

**A GitHub Actions infrastructure outage on 2026-08-06** made action downloads fail; the
Trivy "failure" on PR #72 was a setup failure, not a security finding. Re-read any scan
result from that day before treating it as signal.

**BATCHER's policy was raised to min 0.6 / target 1.2 / maxTopUp 0.6** — roughly a
three-day floor at the measured 0.142–0.181 ETH/day burn. Confirm the first top-up under
the new policy moves `target − balance` and no more.

**PHASE 4 IS EXITED (2026-08-06).** All three §20 exit criteria are met with evidence,
not assertion. Four ForteL2 wallets are enrolled (HARVEST, ADMIN, BATCHER, PROPOSER) in
project `fortel2` / environment `development`.

| §20 Phase 4 exit criterion                                                    | Evidence                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Long-running ForteL2 wallets remain above policy minimum during a test period | ✅ **Two unattended restorations**, both verified on-chain — table below. |
| API and cron concurrency tests pass                                           | ✅ T4.4 (C16) + TX.10 — 91 integration tests, **0 skipped**.              |
| Failure and recovery alerting works                                           | ✅ T4.3 (C15), unit + integration covered.                                |

**The two unattended cycles.** BATCHER (min 0.15 / target 0.4) burned below minimum and
was restored by the **scheduled** cron both times, no operator action. Amount,
destination, receipt and treasury-nonce continuity were verified against a public Sepolia
node each time — not read off the dashboard:

| Cycle | Restored (UTC)      | Pre-balance | Transfer                                          | Nonce |
| ----- | ------------------- | ----------- | ------------------------------------------------- | ----- |
| 1     | 2026-08-04 18:00:36 | 0.1267 ETH  | `0xbc4adabf…121e`, blk 11418955, 0.2732862874 ETH | 2     |
| 2     | 2026-08-06 06:00:36 | 0.1278 ETH  | `0xff52dc6c…a1d5`, blk 11429428, 0.2721720071 ETH | 4     |

Both landed within ~36 s of a `0 */6 * * *` boundary, both moved exactly
`target − balance`, both receipts `0x1`. Measured burn: 0.142 → 0.181 ETH/day, rising.

**A real foreign transaction crossed the treasury mid-window, and the system absorbed
it.** On 2026-08-05 17:48:12 UTC the operator sent **1 ETH to HARVEST by hand**
(nonce 3, `0xb10c651e…`; confirmed by the operator 2026-08-06). This is exactly the class
of event C14's crash-orphan scan exists to catch — a treasury transfer no
`funding_transactions` row explains. Three consequences, all load-bearing:

- **Dispatch was unharmed.** The next scheduled run read the account nonce fresh inside
  the advisory lock and used nonce 4 with no conflict — an externally consumed nonce did
  not wedge funding (C7 / TX.10 / TX.8).
- ✅ **The detector fired — verified 2026-08-06.** The 2026-08-05 18:00:20 UTC run
  recorded `unexplained_transfer_count: 1` with
  `{kind: 'unexplained_outgoing_transfer', severity: 'critical', nonce: 3, valueWei:
'1000000000000000000', toAddress: '0x5128…652d', blockNumber: '11425869',
transactionHash: '0xb10c651e446f00a58b…'}` — twelve minutes after the operator's manual
  send. **Live-fire proof of C14's crash-orphan scan against a transfer it had never
  seen.** Discrimination is sound: the five surrounding runs recorded zero unexplained
  transfers, and the 06:00 run that funded BATCHER reported `unexplained 0` — it
  recognised its _own_ transfer as explained while flagging the foreign one.
- **Soft spot this exposed, now measured rather than suspected:** that 18:00 run recorded
  `wallets_funded: 0`, no `error_code`, `outgoing_scan_status: 'complete'` — it classifies
  as a **success** under C15. The critical finding sat in `findings_json` for over a day
  and **nothing** happened: no email, no dashboard surface, no log line (findings are
  logged nowhere — confirmed by reading both `wallet-reconciler.ts` and
  `reconcile-wallets.ts`). It surfaced only via a hand-written database query. Tracked as
  **TX.15**.

**Scope note:** Phase 4 exiting completes this effort. Phases 5–8 remain out of scope;
TX.15, threshold changes, and any mainnet work are new scope the operator initiates.

| Task                                                          | Status        | Landed in                  |
| ------------------------------------------------------------- | ------------- | -------------------------- |
| T1.1 schema + migration `0001`                                | ✅ done       | PR #2                      |
| T1.2 funding math domain                                      | ✅ done       | PR #2                      |
| T1.3 wallet registration + policy APIs                        | ✅ done       | PR #7                      |
| T1.4 signer infrastructure                                    | ✅ done       | PR #2                      |
| T1.5 funding dispatch engine                                  | ✅ done       | PR #8                      |
| T1.6 `ensure-funded` endpoint                                 | ✅ done       | PR #13                     |
| T1.7 funding history API + dashboard                          | ✅ done       | PR #11                     |
| T1.8 reserve-exhaustion email                                 | ✅ done       | PR #21                     |
| T2.1 projects/environments + scoped authz (migration `0002`)  | ✅ done       | PR #7                      |
| T2.3 operation status + confirmation resume                   | ✅ done       | PR #10                     |
| T2.4 dashboard project/environment/wallet/policy views        | ✅ done       | PR #20                     |
| T3.1 alert state machine                                      | ✅ done       | PR #5                      |
| T3.2 email templates                                          | ✅ done       | PR #6                      |
| T3.3 alert persistence + cron/manual orchestration            | ✅ done       | PR #12                     |
| T3.4 operational runbooks (PRD §19)                           | ✅ done       | PR #14                     |
| TX.1 CI pipeline                                              | ✅ done       | PR #4, fixed in #9         |
| TX.2 API hardening (helmet, CORS, rate limit)                 | ✅ done       | Phase 0 + PR #13           |
| TX.4 credential list / disable / revoke / enable              | ✅ done       | PR #16, #17                |
| TX.6 alert lookup filtered by alert type                      | ✅ done       | PR #15                     |
| T1.9 concurrency integration tests                            | ✅ done       | PR #35                     |
| T2.2 `ensure-ready` endpoint (contract C11)                   | ✅ done       | PR #33                     |
| TX.5 treasury row lifecycle + ambiguity guard (C12)           | ✅ done       | PR #32                     |
| TX.7 list-environments route (C13)                            | ✅ done       | PR #34                     |
| TX.8 confirm-outside-lock race fix (C7 amendment)             | ✅ done       | PR #37                     |
| TX.3 docs refresh (README + PRD §25)                          | ✅ done       | PR #39                     |
| T4.1 reconciliation use case (C14, migration `0004`)          | ✅ done       | PR #40                     |
| T4.2 reconciler cron entry + Render blueprint                 | ✅ done       | PR #41                     |
| T4.3 reconciliation failure alerting (C15)                    | ✅ done       | PR #42                     |
| TX.9 outgoing-scan defects (C14 amendment, migration `0005`)  | ✅ done       | PR #44 (two review rounds) |
| T4.4 cron-vs-API concurrency (C16)                            | ✅ done       | PR #46 (one case `.skip`)  |
| TX.10 crash-duplicate prevention (C7 amendment)               | ✅ done       | PR #48 (two review rounds) |
| TX.11 dashboard reconcile toggle + `weiTransferred` log       | ✅ done       | PR #53                     |
| TX.12 dashboard design-system pass (presentation only)        | ✅ done       | PR #56 (+ #58, #59)        |
| TX.13 live wallet balances (C17)                              | ✅ done       | PR #61                     |
| TX.14 nonce-gated scan skip (C14 amendment, migration `0006`) | ✅ done       | PR #64                     |
| TX.15 escalate critical reconciliation findings (C18)         | ✅ done       | PR #72                     |
| TX.16 reconciliation-runs endpoint + dashboard findings (C19) | 🔄 dispatched | — prompt issued 2026-08-06 |
| TX.17 operator acknowledgement of finding alerts              | 📋 open       | — not yet dispatched       |

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
2. ✅ **Crash-after-broadcast gap — CLOSED. Detection by T4.1/C14 + TX.9;
   prevention by TX.10 (PR #48, merged 2026-08-02).** A backend killed mid-send
   used to roll back the in-lock rows: the operation stayed `pending`, the wallet
   was NOT wedged, and a transfer that reached the network left no DB trace and no
   recorded nonce. Row-based reconciliation could not find it, so T4.1 compares
   on-chain treasury transactions against expected state and TX.9 made that scan
   able to finish — an orphan is reliably surfaced as a critical
   `unexplained_outgoing_transfer`. **T4.4 then measured the other half:** because
   nothing durable gated the next racer, a waiting API request sent a _second_
   transfer (`sendCalls=2`, one DB row). TX.10 closed it with a durable
   pre-broadcast intent committed outside the advisory-lock transaction — the same
   scenario now yields `sendCalls=1`, and a different idempotency key is refused
   with `PENDING_FUNDING_EXISTS` instead of submitting.

   **Residual, stated rather than implied:** a crash between the intent commit and
   the broadcast wedges that wallet (`submission_unknown` / `BROADCAST_INTENT`, no
   hash) until reconciliation proves the nonce was never consumed. Fail closed by
   design (AGENTS.md §7.5). On an otherwise idle treasury the nonce may not advance
   on its own, so the wedge can persist — `docs/runbooks/recover-stuck-pending-nonce.md`
   carries the identification query and the rule that the gate must never be cleared
   by hand without positive on-chain evidence.

### Next wave

✅ **Wave 5a complete:** TX.8 (#37), T4.1 (#40, C14), TX.3 (#39).
✅ **Wave 5b complete:** T4.2 (#41) and T4.3 (#42, C15) merged — the reconciler cron
is deployed on Render and has completed live runs.
✅ **Wave 5c:** **TX.9** merged (#44) after two review rounds — the outgoing scan is
incremental and forward-contiguous, and the nonce hunt bisects. **Wave 5d (now):**
**T4.4** 🔴 cron-vs-API concurrency (contract **C16**) is prompted and unblocked —
dispatch it. **D6 was reconfirmed and superseded** (2026-08-02) — details in the
T4.4 entry. Phase 4 exits with T4.4.

**Live-operation status (2026-08-02, after TX.9):** the reconciler runs on Render
every 6 hours with the signing key and reaches the funding gate correctly. Two
things are still true and both must be cleared before Phase 4's exit criterion
("long-running wallets remain above policy minimum during a test period") has any
evidence behind it:

- **No wallet has `reconciliation_enabled = true` yet**, so a sweep assesses zero
  wallets. A green run over an empty set proves nothing — check `wallets_assessed`
  on the run row, not the exit code.
- **`RECONCILE_OUTGOING_LOOKBACK_BLOCKS` is still manually lowered in hosted
  config.** TX.9 makes restoring it to `20000` safe (the nonce hunt bisects rather
  than sweeps). Expect the first runs after restoring it to report
  `outgoing_scan_status: 'incomplete'` with an `outgoing_scan_coverage_behind`
  finding while the watermark drains its backlog at roughly 11× real time. **That
  is the fix working, not a regression** — and per C15 it does not page.

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
  **C16** (pre-assigned). **In review as PR #46 — changes requested 2026-08-02
  (small; one skipped case to convert). Publishes C16.**
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

  **Review outcome (planner, 2026-08-02) — PR #46, small change requested.** Gate
  re-run locally and green: 428 unit, 83 integration + 1 skipped. Scope held (no
  `src/`), the `createFakeSigner` extension is additive with defaults unchanged,
  and the three TX.9-shape assertions pin the corrected behaviour. Six real cases
  land. **The one skipped case surfaced a genuine, quantified finding — see TX.10.**
  The planner un-skipped it and instrumented it rather than trusting the
  rationale: the assertion the prompt demanded (`submission_unknown` left pending
  after a backend kill) is **unachievable**, because `pg_terminate_backend` rolls
  back the in-lock rows so no such row is ever created — a planner prompt error
  that conflated the crash path with the ambiguous-post-broadcast path.

  **Merged as-is with the skip (operator decision, 2026-08-02); the three
  requested tests move into TX.10's scope rather than being dropped.** TX.10 has
  to rewrite that case anyway — it is precisely the behaviour TX.10 changes — so
  writing them twice would be waste. They are listed in the TX.10 entry below and
  must not be quietly lost: **if TX.10 lands without them, the skip has simply
  been inherited** and the suite still reports green on an unverified property.

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

- **TX.9** ✅ 🔴 Make the treasury outgoing scan usable in production `[T4.1, T4.2]`
  — DONE (PR #44, two review rounds); amends contract **C14** (no new number)
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

  **Round 2 accepted and merged (planner re-review, 2026-08-02).** All three
  blockers fixed and all four minors addressed. Verified by re-running the round-1
  probes rather than by reading the diff:

  - The crash-orphan at block 5 000 that the tip-facing plan silently abandoned is
    now **reported** — window `[1_001, 21_000]`, status `incomplete`, marker
    advanced to `21_000`, never past an unscanned block.
  - Successive runs tile contiguously with no gap
    (`[1_001, 21_000] → [21_001, 41_000] → [41_001, 50_000]`), so a backlog drains
    instead of being abandoned.
  - The aged-row nonce hunt dropped from **20 001** RPC round trips to **17**
    (16 bisect probes + 1 `getBlock`), and still fails closed on an RPC failure at
    any probe.
  - Watermark advances are flushed only after `markFinished`, so a kill re-scans
    rather than skips.

  Gate re-run locally: 428 unit, 77 integration; migration `0005` re-proved forward
  from `0004` on populated data. C14's amendment no longer contradicts itself —
  "advance only on a genuinely complete scan" is stated consistently. C15 untouched.

  **Hosted follow-up:** `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` can now be restored to
  `20000`. See the live-operation status note near the top for what to expect on
  the first runs afterwards.

- **TX.10** ✅ 🔴 Prevent crash-induced duplicate transfers `[T1.5, TX.8, T4.4]`
  — DONE (PR #48, two review rounds); amended contract **C7** (no new number)
  **Quantified by T4.4 (PR #46) on 2026-08-02, in the exact race P4-US2 names.**
  This is the long-known crash-after-broadcast gap — T1.9 found it, T4.1/C14 and
  TX.9 addressed **detection** — but prevention was never closed, and T4.4 is the
  first time the duplicate has been measured rather than reasoned about.

  **Measured:** kill the lock-holding backend mid-send while an API racer waits on
  the advisory lock, then let both settle:

  ```
  sendCalls=2   unknowns=0   funding_transactions rows=1   statuses=["confirmed"]
  ```

  Two transfers broadcast on-chain; one DB row. The killed backend's in-lock rows
  roll back, so the first transfer leaves **no trace and no recorded nonce** — and
  because nothing is pending, the waiter re-reads a not-yet-mined balance,
  recomputes the same top-up, and sends again. The wallet is funded twice and the
  treasury is debited twice.

  **Why this is tolerable today, and why it still needs fixing.** TX.9's outgoing
  scan detects the orphan as a critical `unexplained_outgoing_transfer`, so the
  money is never silently lost — but detection is after the fact. P4-US2's
  criterion is that concurrent jobs and API calls do **not** issue duplicate
  transactions. Phase 4 must not claim that criterion is fully met; it is met for
  lock serialization, nonce discipline, reserve behaviour, and watermark
  integrity, and **not** for crash-induced duplicates. Recorded as an accepted,
  detected risk until TX.10 lands.

  **Direction (not yet a design — the worker owns this):** the in-lock rows
  rolling back is the root cause, so an intent record must survive the crash.
  Likely a pre-broadcast intent row written and committed **outside** the
  dispatch transaction (or via a separate connection) so a killed backend leaves
  a durable "a send may have gone out at nonce N" marker that gates the next
  racer, converging on the same `submission_unknown` semantics C4 already
  defines. Push back if that is the wrong shape.

  **Required test scope — inherited from T4.4's review, do not drop.** T4.4 merged
  with its crash case `.skip`-ped; these three were requested there and moved here
  because TX.10 rewrites that case anyway. All live in
  `test/integration/cron-vs-api-concurrency.test.ts`:

  1. **Un-skip and invert the crash case.** After the fix, killing the lock holder
     mid-send while an API racer waits must yield **one** transfer, not two —
     `sendCalls === 1` — and the interrupted attempt must leave a durable record
     that gates the waiter rather than vanishing.
  2. **Assert the detection safety net still fires.** TX.9's outgoing scan must
     report a genuinely orphaned transfer as a critical
     `unexplained_outgoing_transfer` under this race. This is currently untested
     and must remain true after TX.10 — prevention must not silently disable the
     detector that has been covering for it.
  3. **Ambiguous post-broadcast failure under race.** Using the
     `sendError` → `RPC_UNAVAILABLE` pattern from
     `test/integration/funding-crash-recovery.test.ts:219` (a _different_ path
     from a backend kill — this one does produce a row), assert
     `submission_unknown` is left **pending** and the racer submits no second
     transfer.

  **Phase 4 exits when this lands** (operator decision, 2026-08-02) — so a
  `.skip` in this task is not an acceptable outcome. If any of the three cannot be
  written, stop and report `blocked` with the reason rather than skipping it.

  **Do not weaken T4.4's other tests to make this pass** — update them to assert
  the new behaviour and call that out explicitly in the handoff.

  **Delivered and merged (planner review, 2026-08-02 — two rounds).** Round 1
  built the fix: `insertBroadcastIntent` commits a `submission_unknown` row with
  the reserved nonce on the **outer** pool connection (not the advisory-lock unit
  of work) before the signer is called, so terminating the lock-holder cannot
  erase the gate. Verified against the branch, not the description — `uow.transactions`
  is built on the transaction client while `dependencies.transactions` is built on
  the pool. All three required tests landed and the skip count went to **zero**;
  the crash case now asserts `sendCalls === 1`, and
  `funding-crash-recovery.test.ts` flipped from asserting fail-open (`funded`, one
  send) to `PENDING_FUNDING_EXISTS` with zero sends — a strengthening, correctly
  disclosed.

  Round 2 added a startup guard: signing-capable roles refuse to boot when
  `DATABASE_POOL_MAX < 2`, because dispatch now needs a second pooled connection
  while the lock holds the first. `cron-reconciler` default raised 2 → 3 for
  headroom. `BROADCAST_INTENT` documented in
  `docs/runbooks/recover-stuck-pending-nonce.md` with the field-value table, the
  identification query, and the idle-treasury wedge.

  **Planner error worth remembering.** The round-1 review claimed a pool of 1
  produces an unbounded silent deadlock. The worker pushed back, citing the
  pre-existing `connectionTimeoutMillis: 10_000`. Re-measured with a longer probe
  window: the dispatch rejects with `DATABASE_UNAVAILABLE` at ~10.0s having made
  **zero** send calls — bounded and fail-closed. The original probe's own 8s
  timeout had fired first. The wrong mechanism had already been written into two
  source comments and C7 (where it contradicted itself); the planner corrected all
  three in `28a72b1`. The guard stands; only its justification changed, from
  "prevents a silent deadlock" to "converts a per-request 10s stall into a startup
  failure." **A worker that verifies a reviewer's claim instead of implementing
  against it is behaving correctly.**

- **TX.11** 🟢 Dashboard reconciliation toggle + `weiTransferred` in the run log
  `[T2.4, T4.2, TX.10]` — **no contract number** (publishes no interface)
  Both gaps were hit operating the first live reconciliation rollout on 2026-08-02,
  and neither is a defect.
  1. **The dashboard shows `reconcile on/off` but cannot change it.** Enrolling a
     wallet is a `curl PATCH` today, so it needs a terminal, an exported token and a
     wallet UUID for what is conceptually a switch. `PATCH /v1/wallets/:id` already
     accepts `reconciliationEnabled`; `dashboard/src/api.ts` already has the
     identical `setWalletEnabled`, and the row already renders the flag. No `src/`
     API change.
  2. **The completion log omits the amount transferred.** It reports
     `walletsFunded: 1` but not how much moved, so confirming the value means a
     block explorer. `counters.weiTransferred` is a **bigint** — it must be
     `.toString()`, since pino throws on raw bigints and would turn a successful
     run into a crash on its final log line.

  Test posture is the thing to get right: **no dashboard test harness exists**
  (`test/unit/` has no dashboard directory, no component tests anywhere), and this
  task must not build one — verify by hand and disclose exactly what was checked.
  The log change _is_ unit-testable via `test/unit/jobs/wallet-reconciler-exit.test.ts`
  and must assert `weiTransferred` serialises as a string, including `"0"`.

  **Delivered and merged (planner review, 2026-08-02).** Gate re-run locally: 431
  unit, 86 integration, 0 skipped; scope held (no `src/api`, no migration, no
  contract number). The bigint hazard was handled better than specified — the log
  fields were extracted into `buildReconcilerCompletionLogFields` with an explicit
  `readonly weiTransferred: string` return type, so stringification is
  **type-enforced** and a regression fails `typecheck` rather than production. The
  test asserts `JSON.stringify({ weiTransferred: 0n })` **throws**, documenting why
  the conversion exists rather than only that it happened. `weiTransferred` was also
  added to the heartbeat `detail` (same JSONB bigint hazard), with the reasoning
  stated rather than done silently. The enable confirm names the consequence — the
  reconciler may fund the wallet automatically within 6 hours — which is what makes a
  one-click control safe for someone not thinking about cron schedules.

  **Known and accepted:** no dashboard component-test harness exists, so the toggle
  is hand-verified only; the cancel-confirm path and `policyWallets` dual-table drift
  under concurrent edits are not automatically exercised. Disclosed in the handoff
  rather than implied. The `6 hours` string in the confirm dialog is hardcoded and
  would go stale if the cron schedule changed.

- **TX.12** 🟢 Dashboard design-system pass `[T2.4, TX.11]` — **no contract number**
  (presentation only; no interface published)
  The dashboard is now used daily — since TX.11 it is how wallets get enrolled for
  reconciliation — but its styling is ad hoc: 11 CSS variables, no spacing/radius
  scale, no elevation ladder. Adopt the **structure** of a published design system
  (token architecture, component grammar, scales) driven by **ChainBank's own**
  colours. Explicitly do **not** adopt the source system's brand palette or its
  marketing typography: a 72px hero and 120px section padding are wrong for a dense
  operator tool.

  **The hazard to design around, and the reason this needs care rather than taste:**
  treasury status is signalled by colour, and the new brand green is a green.
  Primary `#18b97f` against status-ok `#1f7a45` is only **2.11** contrast — as hues
  they are easily confused, so on this dashboard green would mean both "healthy" and
  "click me". Resolved by **form, not hue**: CTAs are solid bright pills, status
  badges are pale tints with dark text. A solid pill and a tinted chip are never
  mistaken for one another, including with a green–red deficiency. Acceptance: a
  `critical` treasury and a `healthy` one must be tellable apart **without reading
  the label**.

  Planner pre-verified every token pair to WCAG AA (solid CTA 6.56:1, deep band
  15.31:1, all four soft status chips 6.27–7.65:1) so the worker is not inventing
  colour. Euclid Circular A — the source system's face — is a commercial Swiss
  Typefaces licence and is unavailable; substitute a free geometric sans (Figtree),
  keep IBM Plex Mono for addresses/hashes/wei where monospace alignment matters.

  **Latent bug to fix in passing:** `dashboard/src/styles.css:14` is
  `font-family: 'IBM Plex Sans', Georgia, serif` — if Google Fonts is blocked or
  slow the entire dashboard renders in a **serif**.

  Presentation only: no `src/`, no behaviour change, test counts must be unchanged.
  No dashboard component-test harness exists and this task must not build one —
  hand-verify and disclose exactly what was checked, at which viewports, with all
  four treasury statuses rendered.

  **Delivered — approved at review (planner, 2026-08-02), PR #56.** The alarming
  1,440-line App.tsx diff is 97% indentation churn from a `<main>` wrapper:
  `git diff -w` collapses it to 36 lines, and a semantic fingerprint of every
  `useState`/handler/`onClick`/`window.confirm` is byte-identical between `main`
  and the branch — no behaviour moved. The form-not-hue rule was verified
  **visually**, not only in CSS: the planner ran the branch in a browser and
  rendered all four status chips beside the primary CTA — solid bright pill vs
  pale tinted chip, unmistakable before hue registers. All four invented contrast
  pairs were recomputed independently and matched to the hundredth; the worker
  self-caught `--muted` failing AA (2.94:1) and confined it to
  `input::placeholder`, with visible muted text on `--steel` (5.62:1). The serif
  fallback bug is fixed. Non-blocking observation: `danger` red on **Disable
  reconcile** marks the safety-rollback lever as alarming — demote it to
  secondary styling if operators hesitate to use it in an incident.

- **PR #54 (out-of-band, post-merge review 2026-08-02):** an `escapeHtml`
  refactor landed directly via Cursor without the worker pipeline, to clear
  Semgrep findings. Planner reviewed it after merge: the old chained
  `replaceAll` was **correct** (the `&` pass came first — Semgrep's finding was
  a pattern heuristic, not a vulnerability), and the replacement is genuinely
  better — a single-pass lookup that cannot be reordered into a double-escape by
  a future edit, deduplicating a copy-pasted `escapeHtml` in
  `test-email-template.ts`, with three new tests (the 431 → 434 unit count). No
  concerns with the change itself. Recorded because unreviewed pushes to the
  money-path repo should be a noted exception, not an invisible one.

- **TX.13** 🟢 Live wallet balances in the dashboard `[T2.4, TX.12]` — contract
  **C17** (pre-assigned: new API route `GET /v1/wallets/:id/balance`)
  Operator request (2026-08-02): show each managed wallet's live on-chain ETH
  beside its policy minimum — the Balance/Minimum/Status view the wallets were
  originally specced from. No balance endpoint exists; build on
  `BalanceReader.readBalance` (already fail-closed, never-throws). Fresh read,
  no `balance_observations` write from a GET. **Authz is the security-relevant
  part:** project-service scoping must match C13's `resolveReadableProjectIds`
  pattern — a scoped credential must not read balances outside its scope; role
  matrix covered in tests. Fail closed in the response: an unreadable balance is
  an explicit `unavailable` shape and **never renders as `0`** — dashboard shows
  an "unavailable" chip. Load on demand (button), not on mount: each check is a
  real RPC call and public Sepolia is rate-limited. Chips reuse the TX.12 badge
  system (`below min` warn / `≥ min` ok / `no policy` / `unavailable` unknown).

  **Delivered — approved at review (planner, 2026-08-02), PR #61.** Gate re-run:
  444 unit / 91 integration, 0 skipped; scope held; `ports.ts` untouched
  (`BalanceReader` sufficed). The worker disclosed it could not hand-verify the
  dashboard; the planner closed that gap in a browser against a scratch DB
  seeded with the **real** ForteL2 addresses: harvest read
  **1.399840335572966 ETH** live from Sepolia — the operator's original
  health-dump figure to the wei — with the `≥ min` chip; proposer 0.5 vs min
  0.7 showed `below min`; sequencer showed `no policy`; zero
  `balance_observations` rows were written. The failure path was exercised by
  restarting the API against a dead RPC: every row rendered `unavailable` —
  never `0 ETH`. Better than spec: the response is a tagged `outcome` union
  (`observed` / `unavailable`, both `additionalProperties: false`), so a client
  cannot read a wei field off a failed response — the phantom-zero hazard is
  structurally unrepresentable. Noted for scale: a full-panel check is one live
  RPC read per visible wallet (≤50); fine at 5, batch-endpoint territory at 50.

  Also closes the loop on TX.12's danger-red observation: operator flinched
  (#58 demoted Disable buttons to secondary outline), and disabling the smoke
  project surfaced the default-selection bug (#59 — default now prefers the
  first **enabled** project; the API orders by `created_at` so a retired oldest
  project had become the permanent default scope).

- **TX.14** 🟢 Nonce-gated outgoing-scan skip `[TX.9, TX.10]` — amends **C14**
  (no new number; third amendment), migration **0006** pre-assigned
  Efficiency review of the live cron (operator request, 2026-08-02): a
  steady-state run takes ~19.5s, of which **~14–18s is the incremental scan** —
  ~1,800 new blocks per 6-hour window fetched with
  `getBlock(includeTransactions)` at concurrency 8 (~225 sequential RPC rounds)
  to confirm, on a typical window, an empty set. ~90% of every run proves a
  negative that one call can prove instead.

  **The invariant:** every outgoing treasury transaction consumes exactly one
  treasury nonce, so confirmed-count-at-tip equal to the count recorded at the
  last watermark proves zero outgoing transactions in the window — a skip on
  proven equality IS a complete scan of the window. Store the nonce beside the
  watermark (`treasuries.last_outgoing_scan_nonce`, migration `0006`, nullable —
  **null means cannot-skip, never skip**), read the count **at the scanned
  tip** (not `latest`), and gate: equal → skip + advance + distinct log event;
  delta or read failure or null → full scan exactly as today. Flushed with the
  existing post-`markFinished` watermark advance, not a second write path.
  Inherits C14's stated reorg limitation unchanged. Expected effect: steady-state
  runs drop from ~1,800 scanner RPC calls to ~2, ~19.5s to ~2s; the k-bisection
  refinement for small deltas is explicitly out of scope unless the worker argues
  for it. Both nonce reads the design needs already exist on the scanner (TX.9).

  **Delivered — approved at review (planner, 2026-08-03), PR #64.** Gate re-run:
  449 unit / 91 integration, 0 skipped. Migration `0006` independently re-proven
  forward from `0005` on populated data — watermark preserved, nonce lands
  **null**, and null never skips, so the first post-deploy run per treasury does
  one full seed scan and gates thereafter. Three adversarial probes held: an
  unexplained transfer at the **exact edge block** under delta=1 is reported
  critical (inclusive boundary + detector provably alive on the non-skip path);
  a **nonce regression** (tip below stored — reorg shape) scans rather than
  skips, because the gate is strict equality; and the skip path makes **zero**
  body-scan calls at **≤2 scanner RPCs**, so the ~1,800 → 2 headline is
  measured, not claimed. Better than spec: if the nonce read fails after a
  successful body scan, the advance is **withheld entirely** (run `incomplete`,
  critical finding) — the durable (block, nonce) pair stays atomic, so the state
  can never say "watermark here, nonce unknown." Expected live effect: ~19.5s
  runs drop to ~2s with `skipped_nonce_gate` logged on most runs; the gate's own
  skip/delta logs produce exactly the data needed to decide the deferred
  k-bisection follow-up.

- **TX.15** 🔴 Escalate critical reconciliation findings `[T4.3, C14, C15]` — contract
  **C18** (pre-assigned; amend C15 in place instead only if no new interface is published)
  **Opened by a real event, 2026-08-06.** An operator hand-sent 1 ETH from the treasury
  (nonce 3). The crash-orphan scan is designed to record that as
  `unexplained_outgoing_transfer`, severity **critical** — possible key compromise or a
  crash-orphaned send. But a run that funds its wallets correctly while recording that
  finding classifies as a **success** under C15, which alerts on run _failure_. So the
  finding lands in `reconciliation_runs.findings_json` and **nothing happens**: no email,
  no dashboard surface, no exit-code change. The one signal the system exists to raise is
  the one signal it currently whispers.
  Deliver: critical findings escalate independently of run classification. Likely a
  `treasury_finding` alert type reusing C3a/C10's persist-then-send dedupe (TX.6's typed
  lookup already prevents entity collision), plus surfacing findings in the dashboard run
  view. **Do not change C15's failure semantics** — a funded run is still a success; this
  is an orthogonal channel. **Do not weaken the finding itself**: an unexplained transfer
  stays critical even when benign, because benign-vs-hostile is not a distinction the
  system can safely make.
  **Detection is proven sound (2026-08-06) — this task is purely about escalation.** The
  finding fired with full forensic detail (nonce, value, destination, block, hash) and did
  not false-positive on the system's own transfers, so **no scanner changes are in scope**.
  The only reason it was ever seen is a hand-written DB query: findings reach **no**
  channel today — not email, not dashboard, not logs. Adding a log line for critical
  findings is the cheapest half of this task and is worth doing even if the alert design
  takes longer.

  **Dispatched 2026-08-06.** Scope is deliberately two halves: (1) log critical findings
  at `error` with the full forensic payload — cheap, shippable alone, and would have
  surfaced the 08-05 event in Render logs on the day; (2) a new `treasury_finding` alert
  type on the existing persist-then-send machinery. **The design trap flagged in the
  prompt:** C3a/C10/C15 all alert on a _state_ with a recovery condition and auto-resolve.
  An unexplained transfer is an **event** — immutable, never becomes explained, so there
  is no auto-resolution to copy, and dedupe keyed on the treasury would silence a
  _second_ incident while the first alert is open, reintroducing this very bug one level
  up. Identity should therefore be per-finding (transaction hash), and the worker must
  justify what closes the alert. Dashboard surfacing is **out of scope** — it needs a
  reconciliation-runs HTTP endpoint that C14 deliberately omits; note as a follow-up.

  **Merged as PR #72 (2026-08-06).** C18 published: `treasury_finding` alerts keyed per
  finding (`transactionHash.toLowerCase()`), so a second distinct transfer alerts while
  the first is still open; critical findings log at `error` with the full forensic payload
  before the alert hook runs; escalation is isolated from watermark and peer failures so
  one store failure cannot suppress a later incident in the same run. **No auto-resolution
  by design** — an unexplained transfer is an immutable event, never becomes explained,
  and inventing a recovery condition would clear a key-compromise signal. Open rows
  accumulate as the durable incident record. The follow-up TX.15 named is **TX.16**;
  closing those rows is **TX.17**.

- **TX.16** 🔴 Reconciliation-runs read endpoint + dashboard findings surface
  `[T4.1/C14, TX.15/C18, TX.12, TX.13]` — contract **C19** (pre-assigned: new API route
  `GET /v1/reconciliation-runs`), **no migration**
  The third and last channel for critical findings. TX.15 landed log and email; the
  dashboard — the surface the operator actually uses — still shows nothing, because
  findings live only in `reconciliation_runs.findings_json` and C14 deliberately publishes
  no HTTP endpoint for runs. `src/api/routes/` has no route for them.

  **The authorization grain is the security-relevant decision, and it is deliberately
  unlike every other read endpoint here.** C13/C17's `resolveReadableProjectIds` pattern
  does not apply: reconciliation runs are **treasury-global**, spanning every project, and
  a finding payload carries destination addresses, values, nonces and hashes. There is no
  project to scope to, so scope-based authz cannot express the boundary. New permission
  `reconciliation:read` granted to `operator` and `read-only` **only** — `project-service`
  denied even when holding scope rows, so a scope grant cannot buy treasury-wide forensic
  data. `PERMISSIONS` is an app-level const (additive, no migration); `ROLES` is the
  persisted enum and is untouched.

  **Two traps flagged in the prompt.** (1) `ReconciliationRun.weiTransferred` is a
  `bigint`, and a raw bigint reaching Fastify's serializer **throws** — the same hazard
  TX.11 hit on the logging path, one layer over, and here it would 500 the read of the
  incident record. Type-enforce the conversion the way TX.11's
  `buildReconcilerCompletionLogFields` does. (2) `findings_json` is unvalidated data at
  rest, written across TX.9/TX.14/TX.15 code versions; a response schema with
  `additionalProperties: false` over the `ReconciliationFinding` union would make the
  endpoint **500 on old rows** — failing hardest on the oldest evidence. Direction of
  failure matters: permissive on presentation, never on content. An unrecognised finding
  kind must still appear in the response and must never be silently dropped. A finding
  that cannot be parsed is more interesting than one that can.

  **Stated limitation, not a defect:** the panel shows findings within the runs page it
  fetched — at one run per six hours a 50-run page is ~12 days, so an older critical
  finding will not appear. A standing unresolved-findings banner belongs to TX.17, which
  owns the alerts read surface.

  Explorer links have a wrinkle: a finding carries `transactionHash` and `treasuryId` but
  the run row carries no chain data, while the dashboard already loads
  `TreasuryResource.explorerUrl`. Match client-side on `treasuryId`; render the raw hash
  rather than a guessed link when there is no match.

  No dashboard component-test harness exists and this task must not build one — hand-
  verify and disclose exactly what was exercised, per TX.11/TX.12/TX.13 precedent,
  including that critical and warning findings are tellable apart **without reading the
  label** (TX.12's form-not-hue rule).

  **Dispatched 2026-08-06.**

- **TX.17** 🔴 Operator acknowledgement of `treasury_finding` alerts `[TX.15/C18, TX.16]`
  — contract number not yet assigned
  C18 gives these alerts no close path by design, so open rows accumulate as the durable
  incident record. There is no supported way to close one — and no `alerts` HTTP route at
  all, so an operator cannot even list them without SQL.

  Split out of TX.16 at the operator's decision (2026-08-06) rather than folded in: it
  needs an alerts read endpoint plus a **mutating** close on a possible-key-compromise
  record, with its own audit trail and authz story. Entangling that security review with a
  read-only surface would make both harder to review. Scope when dispatched: list open
  alerts, acknowledge one with an operator note and an `audit_events` row, and a standing
  unresolved-findings banner in the dashboard that does not depend on the runs page
  window. **Acknowledgement must not delete or rewrite the finding** — append-oriented,
  the way C10/C15 resolution already is.

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
4. ✅ **Wave 5c (complete 2026-08-02):** TX.9 (#44, two review rounds).
5. ✅ **Wave 5d (complete 2026-08-02):** T4.4 (#46, C16) — merged with its crash
   case `.skip`-ped; that case and two others move into TX.10.
6. ✅ **Wave 6 (complete 2026-08-02):** TX.10 (#48, C7 amendment) — durable
   pre-broadcast intent. The duplicate T4.4 measured is closed and its test is
   un-skipped and inverted.

✅ **Phase 4 EXITED 2026-08-06** on two verified unattended restorations (see Status).
All planned engineering for Phases 1–4 plus the operability wave (TX.11–TX.14) is merged.
This effort's scope is complete; TX.15 below is newly opened and unstarted.

Merge-order cautions for Wave 5:

- ✅ **TX.9 before T4.4 — satisfied.** `main` now has the corrected shape T4.4
  asserts: windows `[M+1, min(M+C, T)]` advancing to `min(M+C, T)`, status
  `'complete'` only when the window reaches the tip. The T4.4 prompt still tells
  the worker to stop and report `blocked` on tip-facing windows; that guard is now
  a no-op but is worth leaving in as a regression tripwire.
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
