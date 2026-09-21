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
  range already admits the fix — a lockfile refresh should be sufficient and **no manifest
  edit should be needed**.

PR #112's audit and Trivy ran green on 2026-09-01 and the advisories landed in the 21 days
since. Nothing regressed; the world moved.

**Why this gates the wave rather than riding along.** Every Phase 6 PR inherits both reds.
Worse, every brief ends with the standing `/goal keep this PR merge-ready` directive, so a
T6.1 worker will try to fix a failure they did not cause — and the plausible next move is
`npm audit fix --force`, which is a major-version bump of the HTTP framework inside a
money-path refactor. Land TX.26 first and the T6.1 gate means what it says.

`npm audit fix --dry-run` **crashes** in this repo (`Cannot read properties of null (reading
'edgesOut')`, npm arborist), so the fix path is **unmeasured** — the worker must use a
targeted update and re-run the audit rather than trusting a dry run.

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

**Run order:** **TX.26 (security gates, above)** → T6.1 → T6.2 → T6.3 → (T6.4 ∥ T6.5).

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
