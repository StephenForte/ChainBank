# ChainBank P6-PREP Plan — Cleanup before Phase 6

Planner-owned. Goal: close Phase 9 leftovers that a second chain would detonate, then
stop. Do **not** start Phase 6 (T6.1 chain-adapter registry / Base Sepolia) from this
document.

Authority: `tasks/ChainBank_PRD_v4.md` Phase 6, `tasks/DECISIONS.md` (D11–D17, C23–C25),
`AGENTS.md`, and the [commit and merge contract](./worker-plan.md#commit-and-merge-contract)
in `tasks/worker-plan.md`.

Identifiers reserved by this plan (do not grep-and-increment):

| Kind      | Assigned                                                           | Next free after this wave |
| --------- | ------------------------------------------------------------------ | ------------------------- |
| Migration | **0010** landed (P6-PREP-2)                                        | **0011**                  |
| Contract  | C23 and C24 amended in place. **C26** is reserved for Phase 6 T6.1 | **C26** (untouched)       |

Baseline at plan write: `origin/main` **`2db27b7`** (merge of PR #105).
Wave closed: `origin/main` **`0c98dc1`** (merge of PR #111, 2026-09-01).

---

## Wave 0 — Gates (done 2026-08-28)

Operator answers, recorded in `tasks/DECISIONS.md` and PRD §22 / §25.1.

| #       | Decision                                                                                                                                                                         | Record                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **D15** | Skip Phase 5 (ERC-20) until a concrete need. Phase 6 is next. The Phase 6 adapter stays native-transfer only; tokens are a later extension, not T6.1. Anvil (D6) stays deferred. | Operator, 2026-08-28                                 |
| **D16** | C23 hatch remains. Mode is **process-global**: every chain is hatch, or every chain is two-tier. No per-chain mix without a new decision.                                        | Operator accepted planner recommendation, 2026-08-28 |
| **D17** | Phase 9 Public/Private is live on Render. Hosted exit criteria treated as met on operator attestation. This session did not re-derive on-chain replenish hashes.                 | Operator, 2026-08-28                                 |

These close the “do not start Phase 6 until…” gates from the 2026-08-28 review.

---

## Wave 1 — P6-PREP-1 planning-doc truth (done)

| Field  | Value                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------- |
| Branch | `docs/p6-prep-1-planning-truth`                                                                     |
| PR     | [#105](https://github.com/StephenForte/ChainBank/pull/105) merged 2026-08-28T23:01:43Z as `2db27b7` |
| Status | complete-with-caveats (planner D15–D17 commit rode along)                                           |

What landed:

- `tasks/worker-plan.md` status: latest migration `0009` / next **`0010`**; contracts through **C25** / next **C26**. Phase 9 merged; Phase 4 still exited; Phase 6 not started.
- `README.md` current-phase paragraph: Phases 1–4 exited; Phase 9 merged; stale “not yet declared exited” claim removed.
- Phase 4 live-evidence tables in `worker-plan.md` left intact (BATCHER hashes/nonces unchanged vs pre-PR `main`).
- D15–D17 written into `tasks/DECISIONS.md`, PRD §22 / §25.1, and the status lines.

Planner review (independent, 2026-08-28): approved. Merge-base was current `main` `9c6b6dc`. CI green on HEAD `6594e29`. Identifier invariant probed: grep for `next free 0009` / `next free C23` / `not yet declared exited` returned no matches; `drizzle/meta/_journal.json` on `main` ends at `0009_two_tier_treasury`; DECISIONS headings stop at C25.

**Leftover (closed by P6-PREP-4):** `README.md` Phase roadmap row `5+` no longer says “out of scope for this effort”.

---

## Wave 2 — P6-PREP-2 and P6-PREP-3 (done)

| Field  | P6-PREP-2                                                                                           | P6-PREP-3                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Branch | `fix/p6-prep-2-enabled-kind-unique`                                                                 | `fix/p6-prep-3-chain-scoped-replenish`                                                              |
| PR     | [#108](https://github.com/StephenForte/ChainBank/pull/108) merged 2026-08-31T23:23:00Z as `635720e` | [#110](https://github.com/StephenForte/ChainBank/pull/110) merged 2026-09-01T00:00:00Z as `6983d37` |
| Status | complete                                                                                            | complete (hosted pending-old-key query skipped; operator declined to block)                         |

What landed:

- **PREP-2:** migration `0010` partial unique `treasuries_one_enabled_kind_per_chain` on `(chain_id, kind) WHERE enabled = true`. `setTreasuryEnabled` refuses a second same-kind enable with `INVALID_CONFIGURATION`. C23 amended in place. Rotation remains disable-then-insert.
- **PREP-3:** replenish prelude keys include `evmChainId` (`ensure-ready:…:chain:${id}`, `reconcile:${runId}:chain:${id}`). C24 amended in place. Reconciler finding copy uses C23 per-kind language, not a raw treasury count.

Planner reviews: both approved against then-current `main`. C26 unused.

## Wave 3 — P6-PREP-4 and P6-PREP-5 (done)

| Field  | P6-PREP-4                                                                                           | P6-PREP-5                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Branch | `docs/p6-prep-4-runbooks-explorer`                                                                  | `fix/p6-prep-5-chain-block-time`                                                                    |
| PR     | [#109](https://github.com/StephenForte/ChainBank/pull/109) merged 2026-08-31T23:51:47Z as `3427b64` | [#111](https://github.com/StephenForte/ChainBank/pull/111) merged 2026-09-01T00:14:02Z as `0c98dc1` |
| Status | complete-with-caveats (approved after rewrite to disable-then-insert)                               | complete                                                                                            |

What landed:

- **PREP-4:** Public rotation runbook is Public-only and names **web + wallet-reconciler** (D12). Operation explorer URLs follow the row’s chain. README `5+` no longer says “out of scope for this effort”. Residual (non-blocking): rollback prose is still slightly pre-`0010` (boot fails the unique index; revert must disable the new row before re-enabling the old).
- **PREP-5:** `SupportedChain.blockTimeMs`; Sepolia is `12_000` and still the only row. Nonce hunt uses `findSupportedChainById(treasury.chain.chainId)`. Unknown chain ID leaves `submission_unknown` pending (no 12_000 guess). `RECONCILE_BLOCK_TIME_MS` remains a named Sepolia default for one release.

Planner reviews: both approved. `SUPPORTED_CHAINS.length === 1`. No `baseSepolia` / `84532` in `src/config` or `src/infrastructure/evm`.

The P6-PREP wave is finished. Do **not** start T6.1 from this document. Run the Final QA checklist, then dispatch T6.1 from a Phase 6 plan.

---

## Historical briefs (Wave 2–3)

### Why this wave existed

The schema already has `chains` and C23 per-chain treasury resolution. The **process** still
assumes one RPC and one `config.chain`. Phase 6’s first real task (T6.1) is the
chain-keyed adapter registry. This wave only removes debt that would make T6.1 wrong
or unsafe:

1. C23 “one enabled row per (chain, kind)” is application-only. `setTreasuryEnabled`
   does not check kind. No partial unique index. Phase 6 rotation multiplies the race.
2. Replenish prelude idempotency keys omit `evmChainId`. `ensure-ready` replenishes
   only `wallets[0].chain`. Same key on a second chain **replays the first replenish**.
3. Public-key rotation runbook still says signing-capable is web-only. `render.yaml`
   and D12 put `TREASURY_PRIVATE_KEY` on web **and** wallet-reconciler.
4. Operation explorer URLs use `config.chain.explorerBaseUrl`, not the row’s chain.
5. Nonce-hunt block time is a Sepolia constant (`RECONCILE_BLOCK_TIME_MS = 12_000`).
   Base Sepolia is ~2s.

### Dispatch table

| Order    | Task                                                | Model                              | Parallel with | After                                         |
| -------- | --------------------------------------------------- | ---------------------------------- | ------------- | --------------------------------------------- |
| Wave 2   | **P6-PREP-2** enabled-kind unique + enable guard    | Stronger (money path + migration)  | P6-PREP-3     | Wave 1 (landed)                               |
| Wave 2   | **P6-PREP-3** chain-scoped replenish keys           | Stronger (money path, idempotency) | P6-PREP-2     | Wave 1 (landed)                               |
| Wave 3   | **P6-PREP-4** runbooks + explorer URL + README `5+` | Cheap                              | P6-PREP-5     | P6-PREP-2 (runbooks mention the enable guard) |
| Wave 3   | **P6-PREP-5** `blockTimeMs` on `SupportedChain`     | Cheap                              | P6-PREP-4     | Wave 1 (landed)                               |
| **Stop** | T6.1 chain-adapter registry                         | —                                  | —             | This entire wave                              |

`tasks/DECISIONS.md` is append-only at C23/C24 and the log tail. Expect a rebase
conflict; keep both sides.

Shared-file collision map:

| File                              | P6-PREP-2          | P6-PREP-3                          | P6-PREP-4 | P6-PREP-5 |
| --------------------------------- | ------------------ | ---------------------------------- | --------- | --------- |
| `src/infrastructure/db/schema.ts` | owned (index only) | no                                 | no        | no        |
| `drizzle/0010_*` + meta           | owned              | no                                 | no        | no        |
| `set-treasury-enabled.ts`         | owned              | no                                 | no        | no        |
| `ensure-environment-ready.ts`     | no                 | owned                              | no        | no        |
| `reconcile-wallets.ts`            | no                 | owned (prelude key + failure copy) | no        | no        |
| `funding-operations.ts`           | no                 | no                                 | owned     | no        |
| `supported-chains.ts`             | no                 | no                                 | no        | owned     |
| `reconciliation-decisions.ts`     | no                 | no                                 | no        | owned     |
| `tasks/DECISIONS.md`              | append C23 + log   | append C24 + log                   | no        | no        |
| runbooks / README                 | no                 | no                                 | owned     | no        |

---

## Not in this wave

Do not dispatch these as cleanup:

- Chain-keyed `BalanceReader` / signer / scanner / tracker registry (`readBalance`
  still takes only `address`). That is **Phase 6 T6.1**.
- Second `CHAIN_RPC_URL` or Base Sepolia in `SUPPORTED_CHAINS`.
- Per-chain treasury-monitor isolation (Phase 6 AC: failure on one chain must not
  block another).
- Closing the C23 hatch (D16 keeps it, process-global).
- ERC-20 / Phase 5 (D15).
- Anvil e2e (D6 still deferred).

T6.1, after this wave: introduce a registry keyed by `chainId` that still registers
**only** Sepolia from `CHAIN_RPC_URL`. `readBalance` must take a chain (or the caller
obtains a per-chain reader). Native transfer only (D15).

---

## P6-PREP-2 — One enabled treasury per (chain, kind)

Paste-ready brief.

```
DISPATCH · Model: stronger · Order: wave 2, parallel with P6-PREP-3 · after P6-PREP-1 (merged as PR #105)
Surface: Cursor
Baseline: origin/main (verify SHA; expected 2db27b7 or later)
Host: any with local Postgres for integration tests
Working directory: this checkout · Landing: one PR; operator merges

TASK: P6-PREP-2 — Enforce C23 in the database and at enable time.

Read first: AGENTS.md §§7,9; tasks/DECISIONS.md C12 + C23 + D16; tasks/p6-prep-plan.md; src/app/treasury/set-treasury-enabled.ts; src/infrastructure/db/schema.ts treasuries table; drizzle/0009_two_tier_treasury.sql; test/unit/app/treasury/set-treasury-enabled.test.ts; test/integration/treasury-row-lifecycle.test.ts; tasks/worker-plan.md commit-and-merge contract.

Trust the repository over this brief.

LINE OF WORK: fix/p6-prep-2-enabled-kind-unique
REVIEW ARTIFACT: PR from that branch.

PRE-ASSIGNED (do not pick different ones)
- Migration: 0010 (drizzle/0010_treasuries_one_enabled_kind_per_chain.sql + generated snapshot/journal)
- Contract: amend C23 in place. Do not publish C26.

EVIDENCE
- schema.ts comment: “Application enforces one enabled row per (chain, kind)”
- C23: “No unique on (chain_id, kind)” — that sentence meant a full unique, which would block C12 rotation. A partial unique WHERE enabled=true does not.
- setTreasuryEnabled writes enabled=true with no kind/chain uniqueness check
- 0009 added kind but no unique index

WHAT MUST BE TRUE
1. Partial unique index:
   CREATE UNIQUE INDEX treasuries_one_enabled_kind_per_chain
     ON treasuries (chain_id, kind)
     WHERE enabled = true;
   Disabled historical rows of the same kind remain legal (C12 rotation).
2. setTreasuryEnabled: when enabling, if another enabled row of the same kind exists on the same EVM chain, throw INVALID_CONFIGURATION before the write. Disabling remains unrestricted.
3. Amend C23: replace “No unique on (chain_id, kind)” with: full unique is still forbidden; partial unique WHERE enabled=true is mandatory; enable API fails closed with the same error funding would have thrown.
4. Append one decision-log line at the end of tasks/DECISIONS.md. Keep both sides on rebase.

OWNED: src/app/treasury/set-treasury-enabled.ts, src/infrastructure/db/schema.ts (treasuries indexes only), new drizzle/0010_* + meta snapshot/journal, test/unit/app/treasury/set-treasury-enabled.test.ts, test/integration/phase1-schema-constraints.test.ts and/or treasury-row-lifecycle.test.ts.
APPEND-ONLY: tasks/DECISIONS.md (C23 local-design paragraph + log tail).
OFF-LIMITS: funding dispatch, replenish prelude, container/EVM adapters, render.yaml, README, tasks/worker-plan.md, tasks/p6-prep-plan.md, AGENTS.md, existing drizzle/0009_*.sql.

TRAP: a non-partial UNIQUE(chain_id, kind) — that makes C12 disable-then-rotate impossible because the retired row still has the same kind. Consequence: you cannot rotate a treasury.

COVERAGE (properties)
- Enabling a second operational (or second external) on the same chain is refused; the first row stays enabled; no signer is invoked.
- Inserting a second enabled row of the same kind/chain via SQL fails the unique index.
- Inserting a disabled row of the same kind/chain succeeds.
- Re-enabling the same row is a no-op success.
- Existing setTreasuryEnabled authorization tests still deny every non-operator role.

MIGRATION PROOF
- npm run db:generate only after rebasing onto latest main.
- Apply 0010 forward on a database that already has 0009 and at least one enabled external row (and, if present, one enabled operational). If hosted/local data already has two enabled rows of the same kind, STOP and report — do not drop a row.

VERIFICATION (re-run on current origin/main at hand-back)
- npm run format && npm run lint && npm run typecheck
- npm test -- test/unit/app/treasury/set-treasury-enabled.test.ts test/unit/domain/treasury/resolve-treasury.test.ts
- npm run test:integration -- test/integration/phase1-schema-constraints.test.ts test/integration/treasury-row-lifecycle.test.ts
- Do not weaken or skip existing checks. If a test asserted “two enabled treasuries on one chain is always illegal” (old C12), update it to “two enabled of the same kind”, and declare the before→after in the return report.

OUT OF SCOPE: chain-adapter registry, Base Sepolia, replenish idempotency keys, runbook prose (P6-PREP-4).

If you believe a partial unique index is wrong for rotation, stop and argue. Do not ship a full unique.

RETURN FORMAT:
TASK:        P6-PREP-2 — <one line>
LINE OF WORK: fix/p6-prep-2-enabled-kind-unique
REVIEW ARTIFACT: <PR url>
STATUS:      complete | complete-with-caveats | blocked
VERIFICATION: <each check> — pass/fail (run against origin/main as of hand-back)
MIGRATION:   0010 — applied forward on populated data: yes/no, evidence
SHARED FILES TOUCHED: <path> — what changed, why additive
IDENTIFIERS USED: 0010; C23 amendment
EXISTING CHECKS MODIFIED: <or none>
DECISIONS NEEDED: none | <question>
RESIDUAL GAPS: <plainly>

/goal keep this PR merge-ready: fix failing CI checks and bot review comments until everything passes.
```

**Success:** two enabled Publics (or two Privates) on one chain are impossible in Postgres and via `PATCH /v1/treasuries/:id`. Rotation of a disabled historical row still works.

---

## P6-PREP-3 — Chain-scope the replenish prelude

Paste-ready brief.

```
DISPATCH · Model: stronger · Order: wave 2, parallel with P6-PREP-2 · after P6-PREP-1 (merged as PR #105)
Surface: Cursor
Baseline: origin/main (verify SHA; expected 2db27b7 or later)
Host: any
Working directory: this checkout · Landing: one PR; operator merges

TASK: P6-PREP-3 — Replenish every chain in a sweep, with a unique idempotency key per chain.

Read first: AGENTS.md §7.5; tasks/DECISIONS.md C23, C24, D14, D16; tasks/p6-prep-plan.md; src/app/funding/ensure-environment-ready.ts; src/app/funding/replenish-operational-prelude.ts; src/app/funding/ensure-idempotent-operation.ts; src/app/reconciliation/reconcile-wallets.ts (prelude loop ~240–277 and resolveTreasuryForWallet ~716); test/unit/app/funding/ensure-environment-ready.test.ts; test/unit/app/reconciliation/reconcile-wallets.test.ts.

Trust the repository over this brief.

LINE OF WORK: fix/p6-prep-3-chain-scoped-replenish
REVIEW ARTIFACT: PR from that branch.

PRE-ASSIGNED: no new migration. No new contract number. Amend C24 in place (prelude key includes evmChainId).

EVIDENCE (do not “fix” by deleting the loop)
- ensure-ready uses wallets[0].chain.chainId and key `ensure-ready:${environmentId}:${idempotencyKey}`
- reconciler loops chain ids but uses key `reconcile:${runId}` for every chain
- ensureIdempotentOperation replays on (requested_by, key) — a second chain would reuse the first replenish operation

WHAT MUST BE TRUE
1. ensureEnvironmentReady: unique chain ids among enabled wallets; call replenishOperationalPrelude once per chain (same pattern as the reconciler). No wallets → no prelude.
2. Keys:
   - ensure-ready: `ensure-ready:${environmentId}:${idempotencyKey}:chain:${evmChainId}`
   - reconciler: `reconcile:${runId}:chain:${evmChainId}`
3. Single-chain behavior unchanged: one prelude, replay of the same key still one transfer.
4. Fix the reconciler finding copy that treats any count>1 enabled treasuries on a chain as “ambiguous”. Use the C23 resolution error message (per kind), not a raw count. Two-tier (one external + one operational) is not ambiguous.

OWNED: src/app/funding/ensure-environment-ready.ts, src/app/reconciliation/reconcile-wallets.ts (prelude key + failure-reason string only), test/unit/app/funding/ensure-environment-ready.test.ts, test/unit/app/reconciliation/reconcile-wallets.test.ts.
APPEND-ONLY: tasks/DECISIONS.md C24 local-design bullet + one log line.
OFF-LIMITS: schema/migrations, set-treasury-enabled, container, EVM adapters, render.yaml, tasks/worker-plan.md, tasks/p6-prep-plan.md, README.

TRAP: changing the key format without covering single-chain replay. Operators and crons already persist keys. Single-chain replay of the NEW format is required; do not break in-flight operations that used the old format — old keys may still be pending. If a pending row exists under the old key, STOP and report rather than inventing a dual-read scheme.

COVERAGE (properties)
- Two wallets on chain 11155111 and 84532 in one ensure-ready: prelude invoked twice with two different keys and the two chain ids. (Use unit-test wallet fixtures; do not add Base Sepolia to SUPPORTED_CHAINS.)
- Two wallets on the same chain: prelude invoked once.
- Reconciler with two chain ids: two keys, each containing its chain id.
- Same ensure-ready key + same chain: still a replay, not a second replenish.
- FUNDING_DISABLED still aborts the whole ensure-ready sweep.

VERIFICATION
- npm run format && npm run lint && npm run typecheck
- npm test -- test/unit/app/funding/ensure-environment-ready.test.ts test/unit/app/reconciliation/reconcile-wallets.test.ts test/unit/app/funding/ensure-operational-treasury-funded.test.ts
- Do not add a second chain to src/config/supported-chains.ts or src/infrastructure/evm/chains.ts.

OUT OF SCOPE: BalanceReader chain-id parameter, unique index, runbooks, Base Sepolia support.

If you think the old in-flight key is a real hosted risk, report it as DECISIONS NEEDED rather than guessing a dual-read.

RETURN FORMAT:
TASK:        P6-PREP-3 — <one line>
LINE OF WORK: fix/p6-prep-3-chain-scoped-replenish
REVIEW ARTIFACT: <PR url>
STATUS:      complete | complete-with-caveats | blocked
VERIFICATION: <each check> — pass/fail
MIGRATION:   none
SHARED FILES TOUCHED: <or none>
IDENTIFIERS USED: C24 amendment
EXISTING CHECKS MODIFIED: <or none>
DECISIONS NEEDED: none | <question>
RESIDUAL GAPS: <plainly>

/goal keep this PR merge-ready: fix failing CI checks and bot review comments until everything passes.
```

**Success:** a two-chain environment/reconcile sweep replenishes **each** Private treasury; a one-chain sweep still transfers at most once for the same key.

---

## P6-PREP-4 — Runbooks, explorer URL, README `5+`

Paste-ready brief.

```
DISPATCH · Model: cheap · Order: wave 3, after P6-PREP-2 (runbooks mention the enable guard)
Surface: Cursor
Baseline: origin/main after P6-PREP-2 merges
Host: any
Working directory: this checkout · Landing: one PR; operator merges

TASK: P6-PREP-4 — Make rotation runbooks two-tier-accurate, stop using process-level explorer URLs, and fix the README 5+ leftover.

Read first: docs/runbooks/rotate-treasury-key.md, docs/runbooks/rotate-operational-treasury-key.md, docs/runbooks/README.md, src/api/routes/funding-operations.ts, src/api/serializers/funding-transaction.ts, src/api/serializers/funding-operation.ts, src/config/index.ts isSigningCapableRole, render.yaml (TREASURY_*_PRIVATE_KEY on web + wallet-reconciler), README.md Phase roadmap table.

LINE OF WORK: docs/p6-prep-4-runbooks-explorer
REVIEW ARTIFACT: PR from that branch.

WHAT MUST BE TRUE
1. rotate-treasury-key.md:
   - Title/body: this rotates the Public (external) key.
   - Signing-capable services are web AND wallet-reconciler (cite D12 / isSigningCapableRole).
   - Ambiguity is per kind (C23), not “one enabled treasury per chain”.
   - Point at rotate-operational-treasury-key.md for Private.
2. No leftover “isSigningCapableRole is web only”.
3. src/api/routes/funding-operations.ts: explorer URL from the operation/transaction chain (same as serializeFundingTransaction), never container.config.chain.explorerBaseUrl.
4. test/integration/ensure-ready-route.test.ts comment “Exactly one enabled treasury per chain” → “seedPhase1Fixtures already creates the enabled treasury for this chain; do not add another of the same kind”.
5. README.md Phase roadmap row `5+`: do not say “out of scope for this effort”. Phase 5 is deferred (D15); Phase 6 is next after P6-PREP; 7–8 remain later. Keep it one row if you want, but the status cell must match D15–D17.

OWNED: the files listed above plus test/unit/api/funding-operations-route.test.ts if it exists.
OFF-LIMITS: funding math, migrations, container, EVM, tasks/worker-plan.md, tasks/p6-prep-plan.md, AGENTS.md.

TRAP: “fixing” rotate-treasury-key by telling the operator to change TREASURY_ADDRESS and TREASURY_OPERATIONAL_ADDRESS together. Public rotation must stay Public-only.

VERIFICATION
- git grep -n "web only" docs/runbooks/rotate-treasury-key.md  → no match
- git grep -n "config.chain.explorerBaseUrl" src/api/routes/funding-operations.ts  → no match
- git grep -n "out of scope for this effort" README.md  → no match
- npm test -- test/unit/api/funding-operations-route.test.ts
- npm run format && npm run lint && npm run typecheck

OUT OF SCOPE: hosted Phase 9 cutover, Base Sepolia, enable-wallet-reconciliation Sepolia-only wording (still true until Phase 6).

RETURN FORMAT: standard handoff block (TASK / LINE OF WORK / REVIEW ARTIFACT / STATUS / VERIFICATION / MIGRATION / SHARED FILES / IDENTIFIERS / EXISTING CHECKS / DECISIONS NEEDED / RESIDUAL GAPS).

/goal keep this PR merge-ready: fix failing CI checks and bot review comments until everything passes.
```

**Success:** an operator following `rotate-treasury-key.md` updates **both** signing services; operation explorer links follow the row’s chain; README `5+` matches D15.

---

## P6-PREP-5 — Put block time on the chain descriptor

Paste-ready brief.

```
DISPATCH · Model: cheap · Order: wave 3, parallel with P6-PREP-4
Surface: Cursor
Baseline: origin/main (verify SHA; expected 2db27b7 or later)
Host: any
Working directory: this checkout · Landing: one PR; operator merges

TASK: P6-PREP-5 — Stop using a process-global Sepolia block time for nonce-hunt bounds.

Read first: src/config/supported-chains.ts, src/app/reconciliation/reconciliation-decisions.ts (RECONCILE_BLOCK_TIME_MS), src/infrastructure/evm/chains.ts, test/unit/app/reconciliation/reconciliation-decisions.test.ts, tasks/p6-prep-plan.md.

LINE OF WORK: fix/p6-prep-5-chain-block-time
REVIEW ARTIFACT: PR from that branch.

PRE-ASSIGNED: no migration. No new contract. Do not add Base Sepolia. Do not consume C26.

WHAT MUST BE TRUE
1. SupportedChain gains readonly blockTimeMs: number.
2. ethereum-sepolia.blockTimeMs === 12_000 (today’s constant).
3. Nonce-hunt age→blocks uses the chain’s blockTimeMs, not a module-level Sepolia constant. If the reconciler still only has one process chain, plumb it from config.chain / the treasury’s chain descriptor — do not leave 12_000 as a magic number in the hunt.
4. RECONCILE_BLOCK_TIME_MS may remain as a named Sepolia default re-export for one release if tests import it; mark it as the Sepolia default, not “the” block time.

OWNED: src/config/supported-chains.ts, src/app/reconciliation/reconciliation-decisions.ts, callers of RECONCILE_BLOCK_TIME_MS, matching unit tests.
OFF-LIMITS: SUPPORTED_CHAINS length (still one row), viem chain map (still Sepolia only), config env schema (still one CHAIN_ID / CHAIN_RPC_URL), migrations, tasks/p6-prep-plan.md.

TRAP: adding baseSepolia “while you’re there”. That is Phase 6. A second viem chain in the map without a second RPC is a false sense of readiness.

COVERAGE: existing nonce-hunt window tests still pass with 12_000; a unit test on SupportedChain asserts sepolia.blockTimeMs === 12_000.

VERIFICATION
- npm test -- test/unit/app/reconciliation/reconciliation-decisions.test.ts test/unit/config/load-config.test.ts
- npm run format && npm run lint && npm run typecheck
- git grep -n "baseSepolia\\|84532" src/config src/infrastructure/evm  → no new matches

RETURN FORMAT: standard handoff block.

/goal keep this PR merge-ready: fix failing CI checks and bot review comments until everything passes.
```

**Success:** hunt math is parameterized; `SUPPORTED_CHAINS` still has exactly one row.

---

## Final QA checklist (before T6.1)

Wave 2–3 merged. Tick the remaining operator/hosted items, then dispatch T6.1 from a Phase 6 plan.

**Gates (already closed)**

- [x] D15 skip Phase 5
- [x] D16 process-global hatch
- [x] D17 Phase 9 live on Render (operator attestation)
- [x] Wave 1 identifiers assigned; **0010** consumed by PREP-2; next migration **0011**; next contract **C26**

**After Wave 2–3 (verified on merged PRs / `origin/main` `0c98dc1`)**

- [x] `PATCH` enabling a second operational on Sepolia returns `INVALID_CONFIGURATION` (PREP-2 unit + integration)
- [x] SQL insert of a second enabled operational on the same `chain_id` fails the 0010 unique index (PREP-2 integration)
- [x] SQL insert of a **disabled** second operational succeeds (PREP-2 integration)
- [x] Single-chain `ensure-ready` still one prelude, same transfer count as today (PREP-3 unit)
- [x] Unit test: two chain ids → two replenish keys; same chain → one key (PREP-3)
- [x] Public key rotation runbook lists **web + wallet-reconciler** (PREP-4)
- [x] `SUPPORTED_CHAINS.length === 1` (PREP-5)
- [x] `src/infrastructure/evm/chains.ts` still maps only Sepolia (PREP-5 grep)
- [x] `BalanceReader.readBalance` still `(address)` — T6.1 changes that (`src/app/ports.ts` on `0c98dc1`)
- [x] No new npm dependencies (cleanup PRs)
- [x] No mainnet chain id in `src/config`
- [x] README `5+` no longer says “out of scope for this effort” (PREP-4)
- [x] format, lint, typecheck, unit, dashboard, integration, build green on the last cleanup PR (#111)
- [ ] Migration 0010 applied forward from 0009 on **hosted** Render Postgres (CI applied 0010; hosted apply not independently confirmed)

**Honest residual (T6.1 still required)**

- [ ] Phase 6 still needs a config redesign (`CHAIN_RPC_URL` singular) and a chain-keyed adapter registry
- [ ] Treasury-monitor still fails the cron if any treasury RPC read fails
- [ ] Legacy hatch still exists (D16)
- [ ] `ChainConfig` / `ChainDescriptor` still omit `blockTimeMs` (hunt looks up `SUPPORTED_CHAINS`)

---

## How to dispatch

This wave is closed. Do not paste the historical briefs above as new work.

Next: finish the one open Final QA item (hosted `0010` apply, if not already
deployed), then start **T6.1** from a Phase 6 plan. C26 is reserved for T6.1.
One task, one branch, one checkout — see the worker-plan contract.
