# Enable reconciliation for a managed wallet

**Use this when:** you are registering wallets for scheduled reconciliation, or turning
`reconciliation_enabled` on for wallets that already exist. This is the procedure that
takes a reconciler run from `wallets_assessed = 0` to actually funding.

**Do not use this for:** on-demand funding (that is `POST /v1/wallets/:id/ensure-funded`),
emergency stop ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md)),
or threshold changes ([`change-thresholds-safely.md`](./change-thresholds-safely.md)).

## Preconditions

- An **operator** bearer token. `wallet:write` and `project:write` are operator-only;
  `project-service` and `read-only` cannot do this.
- The wallets are on **Sepolia** (`chainId: 11155111`). ChainBank rejects every other
  chain at startup.
- You know each wallet's **minimum**, **target**, and **maximum top-up**. All three are
  required; `target >= minimum` and `maxTopUp > 0` are enforced
  (`src/domain/funding/funding-math.ts`).
- The treasury has enough balance to cover the first sweep **plus** the reserve
  (`TREASURY_MINIMUM_RESERVE_ETH`, currently `0.1`). In-flight transfers count against
  the reserve, so a sweep stops rather than dipping below it.

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'   # operator
```

## 0. Work out what the sweep will actually do — before enabling anything

Funding happens **only** when `balance < minimum`, strictly. At or above minimum is a
no-op even when far below target (PRD §8.2 hysteresis). Two consequences that surprise
people:

- **A minimum of `0` means the wallet can never be funded** — `balance >= 0` is always
  true. If a wallet should be managed, give it a real minimum.
- The top-up goes to **target**, not to minimum, then is clamped by **maxTopUp**. The
  amount that moves is `min(target − balance, maxTopUp)`.

Write out the expected result per wallet first. If you cannot say which wallets will
fund and for how much, do not enable yet.

## 1. Confirm the project and environment exist

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/projects" | jq '.data[] | {id, slug, enabled}'
```

Create them only if missing (slugs are lowercase kebab-case, 2–64 chars):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"<project-slug>","name":"<Project Name>"}' "$BASE/v1/projects" | jq '.data'

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"<env-slug>","name":"<Env Name>"}' \
  "$BASE/v1/projects/<PROJECT_ID>/environments" | jq '.data'
```

Both must be **enabled** — reconciliation eligibility requires an enabled wallet under an
enabled project _and_ an enabled environment (C14).

## 2. Register each wallet with `reconciliationEnabled: false`

Register cold. You want to inspect the policy before the cron can act on it.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "projectId": "<PROJECT_ID>",
  "environmentId": "<ENVIRONMENT_ID>",
  "chainId": 11155111,
  "role": "<ROLE>",
  "address": "<0xADDRESS>",
  "criticalAtStartup": false,
  "reconciliationEnabled": false
}' "$BASE/v1/wallets" | jq '.data | {id, role, address, reconciliationEnabled}'
```

Keep the returned `id` for each wallet. `criticalAtStartup` affects `ensure-ready`
blocking, not reconciliation — leave it `false` unless you specifically want startup to
block on this wallet.

## 3. Set the funding policy

Wei are decimal strings, not hex, and not ETH.

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "minimumBalanceWei": "<MIN_WEI>",
  "targetBalanceWei": "<TARGET_WEI>",
  "maximumTopUpWei": "<MAXTOPUP_WEI>"
}' "$BASE/v1/wallets/<WALLET_ID>/policy" | jq '.data'
```

**`maximumTopUpWei` is your blast radius.** It caps any single transfer regardless of how
far below target a wallet has fallen. Set it deliberately.

## 4. Verify before enabling

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/wallets?environmentId=<ENVIRONMENT_ID>" \
  | jq '.data[] | {role, address, enabled, reconciliationEnabled, policy}'
```

Check every address character by character against your source of truth. Destination
addresses are resolved **only** from this database (AGENTS.md §7.1) — a wrong address here
means funds go to the wrong place, and no later step re-validates it.

## 5. Enable in two stages

**Stage 1 — wallets that are currently above minimum.** These fund nothing, so a run
proves the plumbing (eligibility, balance reads, run summary) with zero money moved:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reconciliationEnabled":true}' "$BASE/v1/wallets/<WALLET_ID>" | jq '.data'
```

Trigger a manual run (Render → `chainbank-wallet-reconciler` → **Trigger Run**) and
confirm `wallets_assessed` matches the count you enabled and `wallets_funded` is `0`:

```sql
SELECT run_id, started_at, finished_at, error_code,
       wallets_assessed, wallets_funded, wallets_noop, wallets_blocked, wallets_failed,
       wei_transferred, outgoing_scan_status
FROM reconciliation_runs ORDER BY started_at DESC LIMIT 3;
```

**Stage 2 — wallets that are below minimum.** Enable these only after stage 1 is clean.
The next run issues real transfers.

## 6. Watch the first funding run

```sql
SELECT ft.status, ft.amount_wei, ft.nonce, ft.transaction_hash, mw.role
FROM funding_transactions ft
JOIN managed_wallets mw ON mw.id = ft.managed_wallet_id
ORDER BY ft.created_at DESC LIMIT 10;
```

Expect `submitted` → `confirmed`. Verify the hash on Sepolia Etherscan and that the
destination matches the registered address.

**`wallets_assessed` is the signal, not the exit code.** A run over an empty or ineligible
set exits `0` and looks identical to a successful sweep. A policy-disabled run also exits
`0` by design (C14 / T4.2).

## Verification

- `wallets_assessed` equals the number of wallets with `reconciliation_enabled = true`
  under enabled projects/environments.
- Wallets above minimum count as `wallets_noop`, not `wallets_funded`.
- `wei_transferred` matches the sum of `min(target − balance, maxTopUp)` over the wallets
  that were genuinely below minimum.
- `outgoing_scan_status` is `complete`, or `incomplete` with an
  `outgoing_scan_coverage_behind` finding while the TX.9 watermark drains a backlog —
  that is expected, not a failure, and does not page (C15).
- No `unexplained_outgoing_transfer` findings. One means a treasury transfer that no
  `funding_transactions` row explains — treat it as **critical** (possible crash-orphan or
  key compromise) and stop.

## Rollback / if this goes wrong

| Symptom                                             | Action                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Funded the wrong wallet or wrong amount             | `PATCH /v1/wallets/:id {"reconciliationEnabled": false}` immediately, then fix the policy. Sent transfers cannot be recalled.                                                      |
| Need to stop everything now                         | [`disable-all-automated-funding.md`](./disable-all-automated-funding.md) — kill switch takes effect after the signing process restarts                                             |
| `wallets_assessed` is 0                             | No wallet has `reconciliation_enabled = true`, or the project/environment is disabled                                                                                              |
| Wallet is below minimum but never funds             | Its minimum is `0`, or its policy is missing, or `blocked/reserve` — check `wallets_blocked` and the run findings                                                                  |
| Run blocked at reserve                              | Treasury below `TREASURY_MINIMUM_RESERVE_ETH` + top-up. Replenish ([`replenish-treasury.md`](./replenish-treasury.md)); the sweep stops and continues, it does not partially drain |
| Row stuck `submission_unknown` / `BROADCAST_INTENT` | [`recover-stuck-pending-nonce.md`](./recover-stuck-pending-nonce.md) — fail-closed by design; never clear the gate by hand                                                         |

Disabling reconciliation on a wallet is always safe and never deletes history.
