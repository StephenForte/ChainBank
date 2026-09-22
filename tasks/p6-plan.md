# ChainBank Phase 6 Plan — Multi-Chain Support (Base Sepolia)

Planner-owned. Goal: satisfy PRD §Phase 6 — chain adapters behind a common interface,
chain-specific policies, independent per-chain treasury/nonce/RPC, no cross-chain
failure coupling — with **Base Sepolia (chain id 84532)** as the first additional chain.

Authority: `tasks/ChainBank_PRD_v4.md` Phase 6, `tasks/DECISIONS.md` (D15–D18, C23–C25),
`AGENTS.md`, and the
[commit and merge contract](./worker-plan.md#commit-and-merge-contract) in
`tasks/worker-plan.md`. P6-PREP is closed — see `tasks/p6-prep-plan.md`; do not dispatch
from it.

Baseline at plan write: `origin/main` **`3a3fbcd`** (merge of PR #112, merged 2026-09-01).

## Phase 6 is code-complete and Base Sepolia is LIVE (2026-09-22)

All five tasks merged: T6.1/**C26**, T6.2/**C27**, T6.3/**C28**, T6.4/**C29**, T6.5/**C30**. `main` at
`a9ccf1c`. Next free contract **C31**, decision **D24**, task **TX.33** (**TX.29**–**TX.32** are reserved
below); migrations through `0010` and Phase 6 consumed none.

**Base Sepolia (84532) is registered and running.** `chainbank-web` went live with both chains at
04:37 UTC, creating the Base chain row and its two treasury rows. Both crons were updated with the
same `CHAINS` value later that day (D23).

Live configuration, for whoever reads this next:

|                       | Sepolia (11155111)                    | Base Sepolia (84532)                       |
| --------------------- | ------------------------------------- | ------------------------------------------ |
| Public / external     | `0x16caE6…8B2B`                       | `0x16caE6…8B2B` (same, unified 2026-09-22) |
| Private / operational | `0x5128…652d`                         | `0x5128…652d` (same)                       |
| Thresholds            | 0.75 / 0.3 / 1.5 / 0.1                | identical — mirrored, not derived          |
| Operational policy    | min 0.75 / target 1.5 / maxTopUp 0.75 | identical                                  |
| RPC                   | dedicated QuickNode (D20)             | dedicated QuickNode (D20)                  |

Base's numbers **mirror Sepolia rather than being sized for Base**, because SettlementOS's Base
wallets do not exist yet. Re-derive them from `Σ min(target, maxTopUp)` across that chain's wallets
once they do.

### What the cutover cost, and what is still open

Two deploys failed before the third succeeded. **Neither was a code defect** — both were a stale
`CHAINS` value naming the wrong Sepolia Public address, and migration `0010` correctly refused the
resulting second enabled `external`. The genuine findings are recorded as D21 (amended), D23, and:

- **TX.28 — `withDatabaseErrors` discards the Postgres constraint.** ✅ landed in
  [#124](https://github.com/StephenForte/ChainBank/pull/124) (2026-09-22). `client.ts:185` wrapped the
  driver error and the startup line logged only `Database operation "treasuries.upsert" failed`; the
  constraint sat at `error.cause.cause` because drizzle-orm wraps every driver error in
  `DrizzleQueryError`, whose message carries the SQL **and the bound parameters**. Fix: a shared
  `describeErrorChain` in `src/domain/errors.ts` walks ≤5 causes, renders a pg error as
  `code/constraint/table/schema/detail/hint` (never its message), renders the drizzle wrapper by name
  only, and feeds the startup, cron, migrate, dispatch, nonce-probe and unhandled-error log lines plus
  `withDatabaseErrors` `context.detail`. `describeUnknownError` is untouched, so `/health/ready` still
  returns the top-level message only. Worker found that `error-handler.ts` already logged `context`
  for typed failures, so the parameter leak was live on API logs before this PR, not latent.
  Reviewed in a scratch clone: format/lint/typecheck/build green, **73 files / 638 unit**, **27 files /
  132 integration** on `f3b0e63`; probes with the real `pg.DatabaseError` and `DrizzleQueryError`
  classes confirmed the rendered line carries `23505` + constraint + detail and neither SQL nor
  parameter, a Node `ECONNREFUSED` (string `code`, no `severity`) is not mistaken for a pg error, and
  the readiness body for the same failure is unchanged. Known limit, by design: a pg error with no
  `detail` renders as its SQLSTATE alone (`code=28P01` for a bad password), since pg messages can
  embed input values.
- **~1.4 ETH is stranded** in `0xCD1f…9270` on Base Sepolia, outside ChainBank's view, from funding
  the pre-unification Public address. `0x16caE6…8B2B` holds ~0.86 on Base — above the 0.75 warning
  line but not by much. Operator action, no code.
- **Phase 6 is not exited.** Code-complete is not exited: the §20-style evidence pass against the
  PRD's five acceptance criteria has not been done. Four are demonstrable in the repo; "Base Sepolia
  is the first additional implementation" became true today and now needs live evidence — a Base
  treasury observation and a clean two-chain reconciler run.
- **C14 does not cover Base Public** (D22, EIP-7702). Unchanged and deliberate.

## Phase 6 exit evidence pass (draft, 2026-09-22) — NOT EXITED

Same shape as the §20 Phase 4 pass in `worker-plan.md`: each PRD criterion needs evidence, not a
merged PR. Everything below was read from Render logs or the repo on 2026-09-22; nothing was read off
the dashboard. Render's log search 504s on ranges longer than a day, so "today" is all that could be
pulled.

| PRD Phase 6 criterion                                                              | Status     | Evidence                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain adapters expose a common balance, transfer, confirmation, explorer interface | ✅         | C26 registry (T6.1, PR #115): one `ChainAdapters` interface, per-chain balance reader, signer, tracker, scanner, `explorerBaseUrl` on the chain row. Both crons log `Startup chain-id proof finished` with `11155111 matched, 84532 matched` (14:01:50 and 14:03:06 UTC).                                                   |
| Policies are chain-specific                                                        | ✅         | Policies hang off `managed_wallets`, which carry `chain_id` (FK to `chains`); C27 (T6.2, PR #116) validates addresses and thresholds per chain entry. No live Base wallet exists yet, so this is demonstrated by schema and tests, not by a Base policy in production.                                                      |
| Each chain has an independent treasury, reserve, nonce lock, RPC config            | ✅         | Four enabled treasury rows, two per chain (ids `9d359e08…`/`a61b2d5e…` on 11155111, `938e9404…`/`5cd06f84…` on 84532); dedicated QuickNode endpoint per chain (D20); replenish prelude ran per operational treasury (`no-op` ×2 at 14:03:08 and 14:04:28 UTC).                                                              |
| Failure on one chain does not block unrelated chains                               | ✅ live    | 14:03 UTC reconciler run: Base outgoing scan failed twice with `RPC_UNAVAILABLE` (below), yet Sepolia's four wallets were assessed (`walletsNoop 4`), both Sepolia watermarks advanced (`scannedToBlock 11758358`), and `chainOutcomes` lists both chains `processed`. C29 (T6.4, PR #121) behaved as designed, unattended. |
| Base Sepolia is the first additional implementation                                | ⚠️ partial | **Observation: yes.** Treasury monitor 14:01:52 UTC recorded Base external `1855000000000000000` wei and operational `3544586630334914907` wei at block 47158711, both `healthy`, `transition none`. **Clean reconciler run: no.** The Base outgoing scan cannot complete — see TX.29.                                      |

**What blocks exit — found by this pass, not previously known:**

- **TX.29 — Base outgoing scan throttled to the provider budget.** ✅ reviewed and approved
  2026-09-22 in [#127](https://github.com/StephenForte/ChainBank/pull/127), operator merges. Root
  cause as found by the exit pass: the scanner fired `getBlock(includeTransactions)` 8-wide with no
  issuance limit; the first Base scan (20 000 blocks, no watermark) ran at ~44 req/s and QuickNode cut
  it off at 50/s. Fix: a per-scanner token bucket (R starts per one-second window,
  `RECONCILE_OUTGOING_SCAN_MAX_REQUESTS_PER_SECOND`, default 25, no Render change needed) plus
  structural retry-with-backoff on QuickNode's -32007/-32008/-32011, JSON-RPC 429 and HTTP 429;
  everything else still fails closed. **Correction to the earlier hypothesis above:** the block
  window does _not_ need to be time-based. After one complete scan writes the watermark, the nonce
  gate skips Base runs unless the treasury actually sent something, so only the first scan is heavy
  (~13 min at R=25). Planner verification: scratch-clone gate green, **75 files / 647 unit**, **27 / 132
  integration**; real-timer probes with viem's error classes and viem retry disabled: R=10 held at
  10–11 observed/s, -32007 and 429 retried once and completed, plain `Error` still `incomplete`.
  QuickNode's own request logs are enterprise-only, so the exact code returned at 14:04 UTC is
  unknown; both paths are handled. Follow-ups recorded as TX.32, none blocking.
- **TX.30 (reserved) — RPC error detail logs the endpoint URL including its token.** viem's
  `RpcRequestError.message` embeds `URL: https://….base-sepolia.quiknode.pro/<token>/`, and the
  scanner's `Treasury outgoing scan failed` line logs `describeUnknownError(error)` verbatim, so the
  token is in Render logs as of 14:04 UTC today. `rpcUrl` is on the pino redaction list but this is
  inside a message string, which redaction cannot see. Fix: render viem errors from `shortMessage` +
  `details`, never `message`, at every `detail:` site that can see an RPC error (scanner, balance
  reader, tracker, signer); TX.28's `describeErrorChain` needs the same rule for viem-shaped causes.
  **Operator action first: rotate the Base Sepolia QuickNode endpoint token.** Whether Sepolia's has
  ever been logged the same way could not be checked (log search 504); assume yes and rotate both.

- **TX.31 (reserved) — treasury-finding email copy must branch on finding kind.** The
  "Recommended action" in `src/app/email/treasury-finding-template.ts` (line ~31) is one constant:
  "Treat this as a possible treasury-key compromise… verify the transaction on the explorer… rotate
  credentials if the transfer is unexplained." Correct for `unexplained_outgoing_transfer`; wrong
  and alarming for `outgoing_scan_incomplete`, where there is no transaction to verify. The operator
  received exactly that email for the 14:04 UTC Base finding. Small, no migration; dispatch with
  TX.30 since both sit on the reconciler's failure path.
- **TX.32 (reserved) — scanner retry ownership, from the #127 review.** (a) The scanner's transport
  keeps viem `retryCount: 2`, and viem retries HTTP 429 / JSON-RPC 429 / -32005 itself at 150 ms
  doubling, bypassing the bucket and the backoff — under a hard cap a limited second can carry up
  to 3× the paced count. (b) The 6-attempt / 4 s-cap backoff (~7.75 s total) cannot outlast a
  per-minute (-32008) window, so that code always exhausts and fails closed despite being
  classified retriable. (c) Nonce/tip reads and the `findOutgoingByNonce` bisect are unpaced (the
  worker measured peak 12 at R=10 from exactly this). (d) The test helper passes `retryCount`
  inside viem's provider object, where `custom()` ignores it — the suite runs under viem's default
  retry 3, so the scanner's own policy for 429/-32005 is untested in isolation; fix is
  `custom(provider, { retryCount: 0 })`. Shape: transport `retryCount: 0` for the scanner, one paced
  retry loop that owns viem's transient set too, a per-minute-aware budget. Not blocking exit; the
  default 25 leaves 2× headroom.

**Also observed today, recorded so nobody re-derives it:** the 14:00 UTC reconciler run failed at
startup — `FUNDING_ENABLED=true with an operational treasury configured requires a structurally valid
TREASURY_OPERATIONAL_PRIVATE_KEY` — and the 14:02 rerun succeeded, so the key was set on that service
between the two. Fail-closed worked; the fleet rule in D23 covers it.

**Exit condition, stated once:** TX.29 merged and deployed, then one scheduled (not manual)
`chainbank-wallet-reconciler` run whose log shows `outgoingScanStatus: complete`, both Base
`watermark_advanced` lines, and `chainOutcomes` both `processed` — plus TX.30 merged and both QuickNode
tokens rotated. Then this section changes to EXITED with that run's correlation id.

---

## Status — updated 2026-09-22

`main` at **`a5554a2`**. Phase 6 is three tasks in; **zero open PRs**.

| Task                        | Contract | PR                                                         | Outcome                                                                                                                                                                                |
| --------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TX.26 security gates        | —        | [#114](https://github.com/StephenForte/ChainBank/pull/114) | merged. `fast-uri` and `fastify` advisories cleared; root cause was a stale exact pin in `overrides`                                                                                   |
| TX.27 trustProxy (D19)      | —        | #114                                                       | merged. CVE-2026-16732 closed; planner reproduced the forgery against fastify 5.10.0 and confirmed it fails closed after                                                               |
| **T6.1** registry           | **C26**  | [#115](https://github.com/StephenForte/ChainBank/pull/115) | merged. Planner probe: same EOA on two chains resolves to each chain's own signer; sabotaging to address-only lookup reproduces the wrong-chain send and reddens 2 of 5 registry tests |
| **T6.2** multi-chain config | **C27**  | [#116](https://github.com/StephenForte/ChainBank/pull/116) | merged. Planner diffed resolved config on `main` vs branch under the deployed Render env across 6 role/mode combinations — byte-identical                                              |
| **T6.3** Base Sepolia       | **C28**  | —                                                          | next                                                                                                                                                                                   |

Verified baselines on `a5554a2`: **67 files / 613 unit**, 41 dashboard, **25 files / 126 integration**, 0 skipped, `npm audit --omit=dev --audit-level=high` clean.

Verified at plan write: `npm run test:unit` → **62 files / 572 tests passed, 0 skipped**.
PR #112 CI green on all eleven checks. Integration tests run inside the CI job named
**`migration validation`** (it applies migrations, runs `db:check`, then
`npm run test:integration`) — there is no separately named integration job, and its
absence from a check list is not a missing gate.

---

## Blocker — `main` is red on two security gates (TX.26, dispatch before T6.1)

Found 2026-09-21 on PR #113, which changes five Markdown files and nothing else. **The two
failures are pre-existing on `main`, not introduced by that PR.** Reproduced against the
unmodified `3a3fbcd` checkout with a clean working tree, running the workflow's own command:

    npm audit --omit=dev --audit-level=high
    -> 5 vulnerabilities (1 moderate, 4 high); exit 1

Byte-for-byte the same finding CI reports. Two packages:

- **`fast-uri` 3.1.5 and 4.1.2** — four HIGH CVEs (CVE-2026-75899, -75931, -75975, -76172):
  SSRF via repeated hostname percent-decoding and malformed IPv6 normalization, host
  confusion via skipped IDN canonicalization and percent-encoded scheme normalization.
  Fixed in 3.1.6 / 4.1.3. Transitive through `ajv`, `fast-json-stringify` and
  `@fastify/ajv-compiler`. This is also the entire content of the Trivy failure —
  `Total: 8 (HIGH: 8, CRITICAL: 0)`, every row `fast-uri`. Not a misconfiguration finding
  and not a 2026-08-06-style setup failure; the CVE rows are real.
- **`fastify <= 5.12.0`** — moderate: schema-validation bypass via root primitive coercion
  mismatch (GHSA-w2qp-rph6-63g4) and `X-Forwarded-*` spoofing under `trustProxy` hop-count
  (GHSA-3m5p-2c4r-xxw2). `package.json` pins `^5.10.0` and 5.12.5 is published, so the
  existing range already admits the fix and the `fastify` caret does **not** need changing.

PR #112's audit and Trivy ran green on 2026-09-01 and the advisories landed in the 21 days
since. Nothing regressed; the world moved.

**Why this gates the wave rather than riding along.** Every Phase 6 PR inherits both reds.
Worse, every brief ends with the standing `/goal keep this PR merge-ready` directive, so a
T6.1 worker will try to fix a failure they did not cause — and the plausible next move is
`npm audit fix --force`, which is a major-version bump of the HTTP framework inside a
money-path refactor. Land TX.26 first and the T6.1 gate means what it says.

**The fix is measured.** An earlier draft of this section claimed a lockfile refresh would be
enough and no manifest edit would be needed. That was wrong, and testing it took two minutes:
`npm update` cannot move `fast-uri`, because `ajv` and `fast-json-stringify` pin ranges that
top out at the vulnerable versions. Reproduced on a scratch copy of `package.json` and
`package-lock.json` (the repo itself untouched) — with `fastify` bumped but no `overrides`,
all four HIGH remain.

What actually clears both gates is an `overrides` block in `package.json`:

    "overrides": {
      "fast-uri": "^3.1.6",
      "ajv": { "fast-uri": "^4.1.3" },
      "fast-json-stringify": { "fast-uri": "^4.1.3" }
    }

then `npm update fastify && npm install`. Result on the scratch copy:
`npm audit --omit=dev --audit-level=high` → **`found 0 vulnerabilities`, exit 0**, resolving
`fastify` 5.12.5, top-level `fast-uri` 3.1.8, and the `ajv` / `fast-json-stringify` copies
4.2.1. The minimal change is the `overrides` block alone — leave `"fastify": "^5.10.0"` as it
is, since the lockfile moves to 5.12.5 on its own.

That proves **resolution**, not **behaviour**. It was run with `--package-lock-only`, so
nothing was executed. Two changes still need the suite to clear them: `fastify`'s fix is a
schema-validation coercion change (GHSA-w2qp-rph6-63g4), and `fast-uri` under `ajv` moves
4.1.2 → 4.2.1. The integration suite is the gate, not the audit.

Note for anyone re-deriving this: `npm audit fix --dry-run` **crashes** in this repo
(`Cannot read properties of null (reading 'edgesOut')`, npm arborist). Do not treat a dry
run as evidence here; use a scratch copy as above.

---

## Identifiers reserved by this plan (do not grep-and-increment)

| Kind      | Assigned                                                                   | Next free after this wave |
| --------- | -------------------------------------------------------------------------- | ------------------------- |
| Contract  | **C26** T6.1 · **C27** T6.2 · **C28** T6.3 · **C29** T6.4 · **C30** T6.5   | **C31**                   |
| Migration | **none expected** — the schema is already chain-scoped                     | **0011** (unconsumed)     |
| Decision  | **D18** (below)                                                            | **D19**                   |
| Task id   | **TX.26** for the security-gate fix below (TX.25 was the previous highest) | **TX.27**                 |

**No migration is expected in Phase 6.** Verified on `3a3fbcd`: `chains` carries
`chain_id` with a unique key; `treasuries.chain_id`, `managed_wallets.chain_id` and
`balance_observations.chain_id` are all FKs to `chains`; `funding_policies` hangs off
`managed_wallets` and inherits their chain. `0010` already enforces one enabled treasury
per `(chain_id, kind)`. A second chain is new **rows**, not new columns. If a task
believes it needs `0011`, that is a signal to stop and re-check with the planner, not to
generate a migration.

---

## Scope decision — Base is the phase target, not the first task

The operator asked for "T6.1 with Base (Testnet)". Base Sepolia is the phase goal and is
planned end-to-end below, but **T6.1 itself registers no second chain**, for one reason:
T6.1 is the only task in the wave that can be gated as a strict no-behaviour-change
refactor. Every existing unit and integration test must pass unmodified except for fake
signatures. Register Base in the same PR and that gate is gone — a red check no longer
tells you whether the registry refactor or the new chain broke it, on the money path, in
a service that is live on Render (D17).

Base Sepolia lands in **T6.3**, two merges later. The whole wave is four to five PRs, not
a quarter.

---

## D18 — Base Sepolia is Phase 6's second chain

Operator, 2026-09-21. Phase 6 targets **Base Sepolia, EVM chain id 84532**, native ETH,
explorer `https://sepolia.basescan.org`, nominal block time 2 000 ms. Native transfer
only (D15) — no ERC-20 on either chain. The C23 hatch stays **process-global** (D16):
when `TREASURY_OPERATIONAL_ADDRESS` is configured, **every** configured chain runs
two-tier, so enabling Base means provisioning a Base Sepolia operational treasury too.
No mainnet chain enters `SUPPORTED_CHAINS` in this phase (Phase 8 gate).

---

## The three latent defects a second chain turns live

These are not bugs today — `SUPPORTED_CHAINS` has exactly one row. They become bugs on
the day Base is registered, which is why they are fixed before it is.

1. **The signer registry is keyed by address, not by chain.**
   `src/container.ts:232` `getSignerForTreasury` matches `treasury.address` against
   `operationalTreasurySigner.address` / `externalTreasurySigner.address` and returns
   the first match. The same EOA is a valid treasury on both Sepolia and Base Sepolia,
   and `treasuries_chain_address_key` makes that two legal rows. A Base treasury row
   would therefore receive the **Sepolia-bound signer** and broadcast to the Sepolia RPC.
   `dispatch-funding.ts:270` does call `signer.verifyChainId()`, but that compares the
   signer against _its own_ RPC — it cannot see that the signer's chain ≠ the treasury's
   chain. **The failure mode is a silent correct-looking send of real testnet value on
   the wrong chain.** Fixed by C26.
2. **Every read adapter is a process singleton bound to `config.chain`.**
   `balanceReader`, `transactionReceiptTracker` and `treasuryOutgoingScanner` are each
   constructed once in `buildContainer` from `config.chain`. `BalanceReader.readBalance`
   takes only `(address)` — nine call sites, each of which already has a
   `wallet.chain` or `treasury.chain` `ChainDescriptor` in hand. Fixed by C26.
3. **One chain's RPC failure fails the whole cron.**
   `src/jobs/treasury-monitor.ts` sets `anyUnavailable` and throws
   `'One or more treasury balances could not be read'` after the loop. With two chains a
   Base RPC outage marks the Sepolia run failed and pages on it. This directly violates
   the PRD Phase 6 acceptance criterion "failure on one chain does not block unrelated
   chains". Fixed by C29.

---

## Task tree

| Task     | Contract | What it delivers                                                                                                  | Model    |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| **T6.1** | C26      | Chain-keyed adapter registry. Ports take a chain. Registry still holds exactly one chain                          | stronger |
| **T6.2** | C27      | Multi-chain configuration: `config.chains[]`, per-chain RPC + treasury, back-compatible with today's singular env | stronger |
| **T6.3** | C28      | Base Sepolia descriptor, viem map entry, treasury registration, boot-time chain-id proof                          | stronger |
| **T6.4** | C29      | Per-chain failure isolation in treasury-monitor and wallet-reconciler                                             | medium   |
| **T6.5** | C30      | Chain surfacing in API responses and the dashboard                                                                | cheap    |

**Run order:** ~~TX.26~~ → ~~T6.1~~ → ~~T6.2~~ → **T6.3** → (T6.4 ∥ T6.5). The first three are merged.

T6.1–T6.3 are **serial**, not a parallelism failure: all three rewrite `src/container.ts`
and `src/config/index.ts`, and running them concurrently produces one unresolvable
three-way conflict in the file that wires the money path. T6.4 and T6.5 are genuinely
parallel — T6.4 owns `src/jobs/`, T6.5 owns `src/api/routes/` and `dashboard/`.

### Shared-file collision map

| File                                                | T6.1             | T6.2             | T6.3              | T6.4             | T6.5             |
| --------------------------------------------------- | ---------------- | ---------------- | ----------------- | ---------------- | ---------------- |
| `src/app/ports.ts`                                  | owned            | no               | no                | no               | no               |
| `src/container.ts`                                  | owned            | owned            | owned             | no               | no               |
| `src/config/index.ts`, `schema.ts`                  | no               | owned            | no                | no               | no               |
| `src/config/supported-chains.ts`                    | no               | no               | owned             | no               | no               |
| `src/infrastructure/evm/*`                          | owned            | no               | owned (chains.ts) | no               | no               |
| `src/app/bootstrap/register-configured-treasury.ts` | no               | owned            | owned             | no               | no               |
| `src/jobs/*`                                        | mechanical only  | mechanical only  | no                | owned            | no               |
| `src/api/routes/*`                                  | mechanical only  | mechanical only  | no                | no               | owned            |
| `render.yaml`                                       | no               | owned            | owned (env only)  | no               | no               |
| `tasks/DECISIONS.md`                                | append C26 + log | append C27 + log | append C28 + log  | append C29 + log | append C30 + log |

`tasks/DECISIONS.md` collides at the tail of §2 and §4 on essentially every rebase. Keep
both sides; never renumber.

---

## T6.1 — Chain-keyed adapter registry (C26)

**Success:** a chain-keyed registry is the only way application code obtains a balance
reader, receipt tracker, outgoing scanner or signer; the registry contains exactly one
chain; `SUPPORTED_CHAINS.length === 1`; all 572 unit tests and the integration suite pass
with no assertion changed except fake constructor signatures.

Paste-ready brief lives in the session dispatch; its pre-assignments are:

- Contract **C26**, published new in `tasks/DECISIONS.md` §2.
- No migration. **Do not create `drizzle/0011_*`.**
- Do not add Base Sepolia, a second `SUPPORTED_CHAINS` row, or a second viem chain.
- Do not change `src/config/schema.ts` — `CHAIN_ID` / `CHAIN_RPC_URL` stay singular
  until T6.2.

---

## T6.2 — Multi-chain configuration (C27)

`config.chain: ChainConfig` becomes `config.chains: readonly ChainConfig[]` plus a
`defaultChainId`. Env gains a multi-chain form while the existing singular
`CHAIN_ID` / `CHAIN_RPC_URL` / `CHAIN_EXPLORER_BASE_URL` keep working unchanged — the
service is live on Render (D17) and a Blueprint sync must not be able to unconfigure it.
Per-chain treasury addresses and thresholds. Must enforce D16 at load: if
`TREASURY_OPERATIONAL_ADDRESS` is set for any chain it must be set for **all** configured
chains, and the loader fails closed with `INVALID_CONFIGURATION` otherwise.

Read `tasks/DECISIONS.md` CB-04 before touching `render.yaml`: funding gates are
`sync: false` on web and wallet-reconciler for a reason that already caused an 18-hour
silent funding outage.

## D20 — Base Sepolia RPC must be a dedicated endpoint, not the public one

Operator, 2026-09-22. SettlementOS uses `https://sepolia.base.org`, and that endpoint is correct
and healthy — it reports chain `0x14a34` (84532) in ~180 ms. It is adequate for the low-volume
paths: treasury balance reads, nonce lookups, funding dispatch, a handful of calls per run.

**It cannot serve the C14 outgoing scan.** Measured 2026-09-22 against the scanner's real access
pattern (`getBlockByNumber` with `includeTransactions: true`, 8-way concurrency, matching
`BLOCK_SCAN_CONCURRENCY`): **9 of 48 calls returned HTTP 429 "over rate limit" within 1.4 s.**
Base Sepolia produces ~2 s blocks, so a 6-hourly reconciler window is **~10,800 blocks** versus
Sepolia's ~1,800, against a `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` cap of 20,000. The scan needs
10,800 such calls and the endpoint refuses at 48.

The scanner fails closed (C14), so this would not fabricate a clean report — it would return
`incomplete` on every run, and **crash-orphan detection would never work on Base**. That is the
check that caught the operator's manual 1 ETH transfer during Phase 4.

Caveat on the measurement: one sample, 48 calls, from the planner's IP; Render's IP has its own
budget. The conclusion survives the caveat because the shortfall is ~225×, which retries
(`RPC_RETRY_COUNT = 2`) cannot close.

**Decision:** provision a **QuickNode Base Sepolia endpoint** (QuickNode supports `base-sepolia` /
84532; the account today holds only the two Ethereum Sepolia endpoints `L2_Render` and `L2_mini`).
Rejected: scanning on the public endpoint with C14 scoped to Sepolia only, which would weaken C14
per chain; and shrinking the Base scan window, for which no viable size has been measured.

The operator provisions it — the planner did not create a billable resource. **RPC URLs carry API
keys: they stay `sync: false` in `render.yaml` and are never written into these documents.**

## D21 — Base reuses the Sepolia treasury EOA

Operator, 2026-09-22. The same EOA is valid on every EVM chain, so Base Sepolia registers the same
external (and, per D16, operational) addresses as Sepolia. One process-global key produces one
signer per chain, which is already what C26 and C27 build — no new secret env vars, no `render.yaml`
key change, nothing new under the CB-04 sync hazard. Rejected: a distinct Base key, which would
limit blast radius but add secrets to two services.

C26 makes this safe: signer lookup is keyed by `(chain id, address)`, so a shared address cannot
draw another chain's signer. Under the pre-T6.1 address-only lookup this decision would have been
the trigger for a silent wrong-chain send.

**Operator prerequisites before T6.3 deploys** (not before it merges — the PR is source, the
endpoint and funds are deployment config): the QuickNode Base Sepolia endpoint exists, and both the
Public and Private treasury addresses are funded on Base Sepolia.

## T6.3 — Base Sepolia (C28)

Adds `base-sepolia` / 84532 / `blockTimeMs: 2_000` /
`https://sepolia.basescan.org` to `SUPPORTED_CHAINS`, `baseSepolia` to
`VIEM_CHAINS_BY_ID`, and registers its treasuries. Boot must prove each configured RPC
reports the chain id it is registered under before any signer is usable — a Base RPC URL
pasted into the Sepolia slot must fail at startup, not at signing time.

**Operator prerequisites, needed before T6.3 dispatch and not before:**

- A Base Sepolia RPC endpoint (and whether it is the same provider as Sepolia).
- A funded Base Sepolia Public treasury, and — per D16 — a Base Sepolia Private
  treasury, with min/target/max thresholds.
- Whether the same EOA is reused across chains or a distinct Base key is generated.
  Reuse is simpler and the addresses are identical across EVM chains; a distinct key
  limits blast radius. Either is compatible with C26 once signers are chain-keyed.

## T6.4 — Per-chain failure isolation (C29)

`treasury-monitor` and `wallet-reconciler` must complete every healthy chain when one
chain's RPC is unavailable, record a per-chain outcome in the heartbeat detail, and
alert per chain rather than failing the run wholesale. Note C15's existing classification
rules: a per-chain unavailability must not silently classify the run as success either —
that is the TX.15 failure mode.

## T6.5 — Chain surfacing (C30)

API responses and dashboard panels label the chain per treasury, wallet and operation;
explorer links already follow the row's chain after P6-PREP-4. Grouping and per-chain
health in the dashboard.

---

## Carried over from P6-PREP

- [ ] **Open:** migration `0010` applied forward from `0009` on hosted Render Postgres.
      CI applies it; hosted apply was never independently confirmed. Not a T6.1 blocker
      (T6.1 has no migration), but it must be closed before T6.3 puts a second chain's
      rows in that database.
