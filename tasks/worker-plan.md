# ChainBank Worker Plan — Phases 1–4

Planner-owned. Scope: finish the application per `tasks/ChainBank_PRD_v4.md`.
Phase 0 is complete (read-only monitoring, auth, test email, cron, Render blueprint).
Phases 5–8 are explicitly out of scope for this effort.

Every worker must read `AGENTS.md` and `tasks/DECISIONS.md` before starting, and must
follow the **[commit and merge contract](#commit-and-merge-contract)** below — it
governs the branch to work in, which files may be touched, the commit convention, and
the report handed back on completion.

## Status (updated 2026-08-01)

`main` is at 310 unit tests plus 45 integration tests, with CI (format, lint,
typecheck, unit, build, audit, secret scan, migration validation) green on every PR.
No open PRs, no stale branches.

| Task                                                         | Status      | Landed in          |
| ------------------------------------------------------------ | ----------- | ------------------ |
| T1.1 schema + migration `0001`                               | ✅ done     | PR #2              |
| T1.2 funding math domain                                     | ✅ done     | PR #2              |
| T1.3 wallet registration + policy APIs                       | ✅ done     | PR #7              |
| T1.4 signer infrastructure                                   | ✅ done     | PR #2              |
| T1.5 funding dispatch engine                                 | ✅ done     | PR #8              |
| T1.6 `ensure-funded` endpoint                                | ✅ done     | PR #13             |
| T1.7 funding history API + dashboard                         | ✅ done     | PR #11             |
| T1.8 reserve-exhaustion email                                | ✅ done     | PR #21             |
| T2.1 projects/environments + scoped authz (migration `0002`) | ✅ done     | PR #7              |
| T2.3 operation status + confirmation resume                  | ✅ done     | PR #10             |
| T2.4 dashboard project/environment/wallet/policy views       | ✅ done     | PR #20             |
| T3.1 alert state machine                                     | ✅ done     | PR #5              |
| T3.2 email templates                                         | ✅ done     | PR #6              |
| T3.3 alert persistence + cron/manual orchestration           | ✅ done     | PR #12             |
| T3.4 operational runbooks (PRD §19)                          | ✅ done     | PR #14             |
| TX.1 CI pipeline                                             | ✅ done     | PR #4, fixed in #9 |
| TX.2 API hardening (helmet, CORS, rate limit)                | ✅ done     | Phase 0 + PR #13   |
| TX.4 credential list / disable / revoke / enable             | ✅ done     | PR #16, #17        |
| TX.6 alert lookup filtered by alert type                     | ✅ done     | PR #15             |
| Remaining: T1.9, T2.2, TX.5, TX.7, all of Phase 4            | not started | —                  |

**Correction:** PR #23 only _tracked_ TX.7 (the missing `GET /v1/projects/:id/environments`
route) as a plan entry — it did not implement it. Confirmed by grep: only `POST` exists
on that path. TX.7 remains not started; do not treat it as done.

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

**Funding is reachable but still disabled.** The PRD §19 runbooks exist, which was
the §20 gate, and TX.4 removed the SQL-only credential paths. **TX.5** remains: there
is still no supported way to complete a treasury key rotation. It fails closed rather
than mis-spending, but leaves a routine rotation dependent on hand-written SQL, so it
belongs before `FUNDING_ENABLED=true` in a hosted environment. See the "Before arming
funding" checklist at the end of this document.

**Hosted verification is complete.** All four phases passed — read-only, alerting,
verifying the brakes, and live funding on Sepolia — satisfying the PRD §20
requirement for a verified Render deployment. See
`docs/runbooks/verify-hosted-deployment.md` for the procedure and recorded results,
including the two documentation errors the live run disproved.

**Current hosted state:** `FUNDING_ENABLED=true` with `FUNDING_KILL_SWITCH=true` —
funding armed but stopped. The kill switch should stay on until TX.5 closes the
treasury-rotation gap.

### Next wave

T1.8 is merged and hosted Phase 2 confirmed it against real alert traffic. In
parallel now: **T2.2** 🔴 `ensure-ready`, **T1.9** 🔴 concurrency tests, **TX.5** 🔴
treasury row lifecycle, **TX.7** 🟢 list-environments route (not yet started —
see the correction above). Hosted verification is complete; TX.5 is the only item
between this wave and releasing the kill switch.

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
- **T1.8** ✅ 🟢 Reserve-exhaustion alert email `[T1.5, T3.1, T3.2]` — DONE (PR #21)
  Treasury-scoped `treasury_reserve` critical alert on `FUNDING_BLOCKED_RESERVE`,
  persist-then-send dedupe, resolves on the next successful transfer for that
  treasury (contract C10). Hosted Phase 2 confirmed the alert lifecycle against
  real traffic — see `docs/runbooks/verify-hosted-deployment.md`.
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

1. **Wave 4 (now):** T2.2 🔴 `ensure-ready`, T1.9 🔴 concurrency tests, TX.5 🔴
   treasury row lifecycle, TX.7 🟢 list-environments route — all unblocked and
   runnable in parallel. T1.8 is already merged, so T2.2 inherits reserve alerting
   rather than needing it retrofitted.
2. **Wave 5:** T4.1 → T4.2 / T4.3 → T4.4.

Merge-order cautions for Wave 4:

- T2.2 (`ensure-ready`) and T1.9 (concurrency tests) both build on the funding
  application layer; land T2.2 first so T1.9 can cover it.
- TX.5 changes which treasury row funding resolves to, and T2.2 fans out across many
  wallets against one treasury. Land TX.5 before T2.2 if both are in flight, or
  expect T2.2 to need a rebase and a re-read of its reserve assertions.
- TX.7 is independent of everything else and safe to run at any time.

Decision D6 (local chain versus mocked JSON-RPC for e2e) must be resolved before
T4.4, and ideally before T1.9.

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
- **TX.5 remains open.** There is still no supported way to complete a treasury key
  rotation — changing `TREASURY_ADDRESS` inserts a second `treasuries` row and
  funding keeps resolving to the old one until it is disabled by hand. The
  address-only change is a **silent no-op**, not a fail-closed error (proven in
  hosted Phase 4); only a simultaneous key rotation fails closed. Routine rotation
  stays dependent on SQL until TX.5 lands.
- ✅ **Hosted verification complete** (2026-08-01). All four phases passed against
  the live Render deployment, including a real 0.05 ETH Sepolia transfer, idempotent
  replay, and the kill switch refusing under live conditions. See
  `docs/runbooks/verify-hosted-deployment.md`.
- **TX.5 is now the only blocker to releasing the kill switch.** Live testing
  sharpened why: changing `TREASURY_ADDRESS` is a **silent no-op**, not a
  fail-closed error — an operator can believe they rotated the treasury while
  funding continues spending from the old one.
