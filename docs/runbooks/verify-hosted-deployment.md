# Verify a hosted deployment

**Use this when:** you have deployed to Render and need to confirm the running
system actually works — after the first deploy, after a significant change, and
before arming funding. PRD §20 requires a verified Render deployment as part of
the definition of done for every phase.

**Do not use this for:** first-time Blueprint setup — see
[`deploy-render-phase0.md`](./deploy-render-phase0.md). For a failing service,
start with [`verify-cron-execution.md`](./verify-cron-execution.md) or
[`investigate-failed-funding.md`](./investigate-failed-funding.md).

## How this is organised

Four phases, ordered so that nothing irreversible happens until the phases before
it have passed. **Phases 1–2 move no ETH.** Phase 3 verifies the brakes before
Phase 4 arms funding. Stop at the end of any phase; each is meaningful alone.

Record the results at the bottom. A verification with no recorded outcome is not
evidence.

## Preconditions

```bash
export BASE='https://chainbank-web.onrender.com'   # your web service URL
export TOKEN='cb_…'                                # operator token
```

- Note the deployed commit SHA in Render and confirm CI is green for it.
- Have a **disposable** recipient wallet address ready (Phase 4 only).
- Keep Sepolia Etherscan open for Phase 4.

Shell tip: several steps need the treasury id. Set it once and confirm it holds a
bare UUID — an unset or quote-wrapped variable produces
`INVALID_REQUEST: The request did not match the expected schema`, which reads like
a server fault and is not one.

```bash
export TREASURY_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq -r '.data[0].id')
echo "[$TREASURY_ID]"   # expect [8f6b1e2a-…], no quotes, not empty
```

---

## Phase 1 — read-only

Nothing here can move ETH. `FUNDING_ENABLED` should be `false` throughout.

### Health and shared database

```bash
curl -s "$BASE/health/live" | jq
curl -s "$BASE/health/ready" | jq
```

- [ ] `/health/live` returns 200.
- [ ] `/health/ready` reports `status: ok`, with `database` and `rpc` components OK.
- [ ] **Heartbeats list both `web` and `treasury-monitor`.** This is the shared-Postgres
      proof from P0-US2 — a missing monitor heartbeat means the cron has never
      completed a run, whatever the service page says.

### Treasury observation

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' "$BASE/v1/treasuries/$TREASURY_ID/check" | jq
```

- [ ] Address, chain, and balance are correct; status is not `unknown`.
- [ ] **Thresholds match `render.yaml`.** They are version-controlled, so a mismatch
      means the Blueprint sync has not taken — investigate before trusting anything
      downstream.
- [ ] Spendable equals balance minus the reserve.
- [ ] The check returns a fresh `blockNumber` and advances `lastCheckedAt`.
- [ ] **No email arrives** while the treasury is healthy. Silence when healthy is a
      requirement, not an absence of evidence.

### Email delivery

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' "$BASE/v1/admin/email/test" | jq
```

- [ ] The message reaches the operator inbox.
- [ ] **If this fails, stop.** Every alert in Phase 2 depends on it, and continuing
      means testing a system that cannot tell you when it breaks.

### Credential administration

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/credentials?limit=50&offset=0" | jq
```

- [ ] A second operator credential exists (`deploy-render-phase0.md` step 4). The
      self-mutation guard means one operator token cannot manage itself.
- [ ] The response contains **no `token_hash` or `tokenHash`** anywhere.
- [ ] `lastUsedAt` on your own credential is recent.

Then, against a disposable credential (`export THROWAWAY_ID=…`):

```bash
# disable → expect enabled:false, revokedAt:null
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"disable"}' "$BASE/v1/admin/credentials/$THROWAWAY_ID" | jq

# its token now fails → expect 401 "The supplied credential is not valid."
curl -s -H "Authorization: Bearer $THROWAWAY_TOKEN" "$BASE/v1/treasuries" | jq

# enable → works again
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"enable"}' "$BASE/v1/admin/credentials/$THROWAWAY_ID" | jq

# revoke → terminal
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"revoke"}' "$BASE/v1/admin/credentials/$THROWAWAY_ID" | jq

# enable a revoked credential → expect 409 CREDENTIAL_REVOKED
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"enable"}' "$BASE/v1/admin/credentials/$THROWAWAY_ID" | jq

# your own credential → expect CREDENTIAL_SELF_MUTATION_DENIED, token still works
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"disable"}' "$BASE/v1/admin/credentials/$MY_ID" | jq
```

- [ ] Disable stops authentication; enable restores it.
- [ ] **Revocation is one-way** — 409 on re-enable. This is the check that your
      compromise response cannot be quietly undone.
- [ ] Self-mutation refused, and your token still works afterwards.
- [ ] `audit_events` rows exist for each mutation with `previous`/`next` state.

### Dashboard and cron

- [ ] Dashboard renders treasury status, readiness, and funding history; displays no
      secret material.
- [ ] Render → `chainbank-treasury-monitor` → **Trigger Run** exits 0, records an
      observation, sends no email while healthy.
- [ ] The monitor's environment contains **no `TREASURY_PRIVATE_KEY`** (PRD §8.6).
- [ ] `/health/ready` shows the monitor heartbeat advanced.

### Observability

- [ ] Logs are structured JSON with a correlation id per entry.
- [ ] **No secret appears in any log line** — no bearer token or `cb_` string, no
      private key, no full database URL, no email-provider key (AGENTS.md §11).

---

## Phase 2 — alerting

Config-only. Still moves no ETH.

A healthy treasury sits above the warning threshold, so the way to exercise alerts
without moving funds is to move the thresholds instead — which also exercises
[`change-thresholds-safely.md`](./change-thresholds-safely.md) for real. Each change
is a PR against `render.yaml`; CI validates the ladder before it can deploy.

Choose values that place the current balance in the band you want, keeping
`reserve < critical ≤ warning ≤ recovery`.

- [ ] **Warning:** set the ladder so the balance falls at or below warning but above
      critical. Run a check. Expect status `warning` and **exactly one** email.
- [ ] **No duplicate:** run the check again immediately. Expect no second email. This
      is the exactly-once guarantee from P3-US2.
- [ ] **Critical:** raise critical above the balance. Expect status `critical` and
      **exactly one** critical email.
- [ ] **Email content:** chain, treasury address, observed balance, the threshold
      crossed, a recommended action, and a working dashboard link.
- [ ] **Recovery:** restore the production ladder. Expect the alert to resolve and
      **exactly one** recovery email.
- [ ] The `alerts` row moved open → resolved and was **not deleted** (AGENTS.md §9).
- [ ] Optional: leave an alert open past `ALERT_REMINDER_INTERVAL_HOURS` to verify the
      reminder, or lower the interval temporarily.

**Restore the production thresholds before continuing.** Confirm via
`GET /v1/treasuries` rather than assuming the deploy took.

---

## Phase 3 — verify the brakes before arming

The point of this phase is to prove funding refuses _before_ it is capable of
succeeding.

**Two wallets are involved and they are easy to confuse:**

| Wallet                   | Role                              | What ChainBank needs                                 |
| ------------------------ | --------------------------------- | ---------------------------------------------------- |
| **Treasury**             | Holds the ETH and signs transfers | `TREASURY_ADDRESS` **and** `TREASURY_PRIVATE_KEY`    |
| **Disposable recipient** | Receives the test top-up          | Its **address only**, registered as a managed wallet |

The recipient's private key is never requested or stored (P1-US1). If you find
yourself pasting it anywhere, stop.

Do **not** switch to a freshly generated treasury wallet at this point unless you
mean to follow [`rotate-treasury-key.md`](./rotate-treasury-key.md): changing
`TREASURY_ADDRESS` inserts a second `treasuries` row, and funding refuses with
`INVALID_CONFIGURATION` (ambiguous treasury configuration) until the retired row
is disabled via `PATCH /v1/treasuries/:id`.

- [ ] Set `TREASURY_PRIVATE_KEY` on the **web service only**. Confirm it is absent
      from the monitor cron. Confirm the key derives to the address already in
      `TREASURY_ADDRESS` — see `rotate-treasury-key.md` step 2 for how to check.
- [ ] Set `FUNDING_KILL_SWITCH=true`, keep `FUNDING_ENABLED=false`, redeploy.
- [ ] The monitor cron still runs cleanly with no signing key.
- [ ] Register test scaffolding (operator calls): a project, an environment, a wallet
      pointing at your **disposable** address, and a deliberately small policy —
      minimum 0.02, target 0.05, maximum top-up 0.05 ETH, as decimal wei strings.
- [ ] Call `ensure-funded`. Expect **403 `FUNDING_DISABLED`** and **zero ETH moved**.
      This proves the gate holds before you open it.

---

## Phase 4 — funding, live on Sepolia

The first irreversible phase. Supervised only: make the calls, watch the results,
and turn funding off afterwards unless you have decided to leave it armed.

- [ ] Set `FUNDING_ENABLED=true`, `FUNDING_KILL_SWITCH=false`, redeploy.
- [ ] **Wrong-key check first.** Temporarily replace `TREASURY_PRIVATE_KEY` with a
      **different** valid key — leaving `TREASURY_ADDRESS` unchanged — and redeploy.
      Expect `INVALID_CONFIGURATION`: the signer/treasury binding refusing to spend
      from an account that is not the reserve-enforced treasury. Restore the real key
      afterwards.
      **Address-only variant (also fail-closed after TX.5):** changing
      `TREASURY_ADDRESS` alone inserts a second enabled `treasuries` row; funding
      then refuses with `INVALID_CONFIGURATION` (ambiguous treasury configuration)
      and makes **no** signer call. Disable the retired row with
      `PATCH /v1/treasuries/:id` `{ "enabled": false }` before continuing — see
      [`rotate-treasury-key.md`](./rotate-treasury-key.md). Live testing on
      2026-08-01 proved the pre-TX.5 silent no-op; the ambiguity guard closes it.
- [ ] `ensure-funded` with a fresh idempotency key → `funded` or `pending`, with a
      real `transactionHash` and the expected `transferredWei`.
- [ ] Verify on Etherscan: correct destination, correct amount.
- [ ] **Repeat the same idempotency key** → same `operationId`, **no second transfer
      on chain**.
- [ ] A new key against a now-funded wallet → `no-op`, nothing sent.
- [ ] `GET /v1/funding-operations/:id` resolves to `confirmed`.
- [ ] `GET /v1/funding-transactions` shows the row with a working explorer link; the
      dashboard shows it too.
- [ ] **Kill switch under live conditions:** set `FUNDING_KILL_SWITCH=true`, redeploy,
      call `ensure-funded` on a below-minimum wallet → `FUNDING_DISABLED`, nothing
      sent. This is the step that makes the emergency-stop runbook true.
- [ ] Audit rows exist for the funding operations, with a plausible source IP.

### After Phase 4

- [ ] Decide the resting state. Leave `FUNDING_ENABLED=false` unless you have
      deliberately chosen to arm it — see the pre-arming checklist in
      `tasks/worker-plan.md`.
- [ ] Disable the smoke-test project, environment, and wallet. **Disable, do not
      delete** — funding and audit history are append-oriented.
- [ ] Record the results below.

---

## Verification record

Append one entry per verification run. An entry with no date and no commit SHA is
not evidence anyone can rely on later.

### 2026-07-31 — Phase 1 (commit `6ac616c`)

**Result: passed.**

- Health: `/health/live` and `/health/ready` both OK; database and rpc healthy.
- Shared database: heartbeats present for both `web` and `treasury-monitor`.
- Treasury: `healthy`, 2.949542146429504 ETH, fresh read at block 11389189,
  `lastCheckErrorCode: null`.
- Thresholds matched `render.yaml` exactly — warning 0.75, critical 0.3,
  recovery 1.5, reserve 0.1 ETH — confirming the Blueprint sync had taken.
- Reserve math correct: spendable 2.849542146429504 = balance − 0.1 reserve.
- Manual check returned `outcome: observed` and sent no email while healthy.
- Test email delivered to the operator inbox.
- Credential administration: list exposed no hash; disable stopped authentication;
  enable restored it; revoke was terminal with 409 on re-enable; self-mutation
  refused.
- Dashboard rendered all panels correctly and displayed no secret material.
- Cron triggered successfully, recorded an observation, sent nothing.

Notes for the next run:

- The dashboard initially showed `Failed to fetch` on every panel. Cause was a
  **browser extension** (Ghostery) blocking requests — `net::ERR_BLOCKED_BY_CLIENT`
  in the console while `curl` returned 200. Allowlisting the host fixed it. The
  giveaway is Service readiness stuck on "Loading…", since that call is
  unauthenticated and therefore rules out the token.
- Two API defects were found and fixed during this run: paginated list endpoints
  rejected `limit`/`offset` (PR #18), and the treasury-check failures traced to an
  unset shell variable rather than the service.

### 2026-08-01 — Phase 2 (alerting)

**Result: passed.**

Exercised via a stacked three-PR series against `render.yaml` rather than moving
funds — [#24](https://github.com/StephenForte/ChainBank/pull/24) (warning),
[#25](https://github.com/StephenForte/ChainBank/pull/25) (critical),
[#26](https://github.com/StephenForte/ChainBank/pull/26) (restore).

- **Warning:** ladder set to warning 3 / critical 1 / recovery 4 / reserve 0.1 with
  the balance at ~2.9495 ETH. Status transitioned to `warning`; exactly one warning
  email arrived.
- **No duplicate:** an immediate repeat check sent no second email — the exactly-once
  guarantee (P3-US2) held.
- **Critical:** ladder escalated to warning 3.5 / critical 3 / recovery 4. Status
  transitioned to `critical`; exactly one critical email arrived, containing chain,
  treasury address, observed balance, the crossed threshold, a recommended action,
  and a working dashboard link.
- **Recovery:** ladder restored to production values (warning 0.75 / critical 0.3 /
  recovery 1.5 / reserve 0.1 — verified byte-identical to the pre-test `render.yaml`).
  The alert resolved and exactly one recovery email arrived. The `alerts` row moved
  open → resolved and was not deleted.

Note for the next run: after each threshold PR, confirm `GET /v1/treasuries` shows
the new thresholds before running the check — Render's redeploy is not instantaneous,
and checking too early reads the old configuration and looks like a failed alert
when it is really a premature check.

### 2026-08-01 — Phase 3 (verify the brakes)

**Result: passed.**

- `TREASURY_PRIVATE_KEY` set on `chainbank-web` only, confirmed absent from
  `chainbank-treasury-monitor`.
- First attempt failed startup with `INVALID_CONFIGURATION` — the pasted key was
  missing its `0x` prefix (MetaMask's private-key export omits it). Corrected by
  prefixing; documented in
  [`rotate-treasury-key.md`](./rotate-treasury-key.md). This is exactly the kind of
  fail-closed startup rejection the config validator exists to produce.
- `FUNDING_KILL_SWITCH=true`, `FUNDING_ENABLED=false`, redeployed.
- Monitor cron triggered successfully with the signing key present on web but
  absent from the monitor — least privilege held.
- Registered smoke-test scaffolding (project, environment, wallet, tiny policy:
  0.02 / 0.05 / 0.05 ETH).
- `ensure-funded` returned `FUNDING_DISABLED` with zero ETH moved — the gate held
  with a capable signer present but both brakes engaged.

### 2026-08-01 — Phase 4 (live funding on Sepolia)

**Result: passed.** All four hosted verification phases are now complete, satisfying
the PRD §20 requirement for a verified Render deployment.

- **Live transfer:** `ensure-funded` moved **0.05 ETH** from the treasury to the
  disposable managed wallet — the full target, since the wallet started at zero.
  Transaction `0x9a95f50e642acabade6ba3f2062638caf202d0c0486da5b5686ad31a64b83e89`,
  confirmed on Sepolia.
- **Idempotency:** replaying the same key returned the identical `operationId`
  (`88bf0a76-…`) with no second transfer on chain.
- **Operation status:** `GET /v1/funding-operations/{id}` resolved to `confirmed`.
- **Funding history:** exactly **one** row across all the `ensure-funded` calls made
  during the phase — the idempotency guarantee holding on real infrastructure.
- **Kill switch under live conditions:** with `FUNDING_KILL_SWITCH=true` deployed,
  `ensure-funded` refused with `FUNDING_DISABLED` and the public message
  `Funding is temporarily disabled.` — the wording confirms the _kill switch_ fired
  specifically, since `FUNDING_ENABLED=false` produces `Funding is disabled.`
  instead. Nothing was sent.

**The wrong-key check did not work as originally written, and that is the most
valuable finding of the phase.** The step said to change `TREASURY_ADDRESS` and
expect `INVALID_CONFIGURATION`. Instead the transfer succeeded. Cause:
`resolveTreasuryForWallet` selects the oldest enabled treasury row for the chain, so
a changed address inserts a _second_ row while funding continues resolving to the
original — which still matches the unchanged signing key. The step has been rewritten
to change the **key** instead, and the TX.5 entry in `tasks/worker-plan.md` corrected:
changing the address alone is a **silent no-op**, not a fail-closed error as
previously documented.

**Resting state:** `FUNDING_ENABLED=true` with `FUNDING_KILL_SWITCH=true` — funding
armed but stopped, pending TX.5 closing the treasury-rotation gap.

**Independent on-chain verification (2026-08-01):** the transfer was re-verified via
public Sepolia RPC, independently of the ChainBank API — receipt status `0x1`
(success), value exactly `0xb1a2bc2ec50000` wei (0.05 ETH), from the treasury
`0x16cae6aeed87e00bcbcd60062286ab604cfe8b2b` to the disposable wallet
`0xffa06ef7c43a66bc1203c5f154371ac21b8f969f`, chain id 11155111, gas used 21000
(plain transfer), block 11391058, mined 2026-07-31T18:09:36Z. The transaction's
nonce is **0** — the treasury's first outgoing transaction ever — which
independently corroborates the funding-history claim above: exactly one transfer
has ever left the treasury, on the chain itself, not just in ChainBank's rows.

Notes for the next run:

- Several steps failed on empty or placeholder shell variables rather than service
  faults (`INVALID_REQUEST` from a malformed URL). Prefer hardcoding real UUIDs into
  commands, or `echo "[$VAR]"` before each call. Every `INVALID_REQUEST` seen across
  all four phases traced to this, never to the server.
- `ensure-funded` wraps its payload in `data`, so extraction needs
  `jq -r '.data.operationId'`, not `.operationId`.
- **Open cleanup item:** the wrong-key experiment's side effect is still live — the
  temporary `TREASURY_ADDRESS` inserted a second enabled `treasuries` row that
  nothing can currently disable. It is inert for funding today (resolution still
  binds the older row), but it is exactly the ambiguous state TX.5's guard will
  refuse on, so funding would stay refused after TX.5 deploys until the stray row
  is disabled. Confirm with `GET /v1/treasuries` (expect two rows), then disable
  the stray row via TX.5's endpoint as part of its rollout — see the deployment
  note on the TX.5 entry in `tasks/worker-plan.md`.
