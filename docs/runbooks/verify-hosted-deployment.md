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
mean to: changing `TREASURY_ADDRESS` inserts a second `treasuries` row, funding
keeps resolving to the older one, and `assertSignerMatchesTreasury` then fails
closed until the old row is disabled by hand. See the Known gaps table in
[`README.md`](./README.md) and `rotate-treasury-key.md`.

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
- [ ] **Wrong-key check first.** Temporarily point `TREASURY_ADDRESS` at a different
      address and redeploy. Expect `INVALID_CONFIGURATION` — the signer/treasury
      binding refusing to spend from an account that is not the reserve-enforced
      treasury. Restore the correct address afterwards.
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

### Phases 2–4

Not yet run.
