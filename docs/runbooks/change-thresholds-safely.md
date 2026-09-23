# Change thresholds safely

**Use this when:** you need to change treasury warning / critical / recovery /
minimum-reserve ETH thresholds in a hosted environment.

**Do not use this for:** changing the treasury address or signing key — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md). For wallet policy amounts
(`minimumBalanceWei` / `targetBalanceWei` / `maximumTopUpWei`) use
`PUT /v1/wallets/:id/policy`, not this runbook.

## Preconditions

- **Thresholds live inside the dashboard `CHAINS` document, not in `render.yaml`.**
  `CHAINS` is declared `sync: false` with no value on `chainbank-web`,
  `chainbank-treasury-monitor`, and `chainbank-wallet-reconciler`. The Render
  dashboard value is authoritative. A literal `value:` in the Blueprint would be
  reapplied on every sync and would overwrite the operator's document.
- **Do not put the singular chain keys back into `render.yaml`.** `CHAIN_ID`,
  `CHAIN_RPC_URL`, `CHAIN_EXPLORER_BASE_URL`, `TREASURY_ADDRESS`, the four
  `TREASURY_*_BALANCE_ETH` / `TREASURY_MINIMUM_RESERVE_ETH` keys, and the
  `TREASURY_OPERATIONAL_*` amount keys are mutually exclusive with `CHAINS`.
  `loadConfig` refuses to boot when any of them is set beside it. The next
  Blueprint sync would then take all three services down.
- **All three services must carry the same `CHAINS` value** before any of them
  runs (D23). Edit the document on every service, not just web and the monitor.
  Each chain in the document has its own treasury thresholds.
- Repository write access is not required. This is a Render Environment edit of
  an existing `sync: false` variable, followed by a restart of all three
  services. CI does not see the live numbers. Boot does: a bad ladder fails
  **every** process at startup, not just funding.
- Understanding that **configuration is the source of truth**: every web boot and
  cron run calls `registerConfiguredTreasuries`, which upserts thresholds onto
  the row matching `(chain_id, address)`. Editing `treasuries.*_wei` in SQL alone is
  **undone on the next boot/cron**.
- Valid ordering, enforced by `assertValidTreasuryThresholds` at startup:
  critical ≤ warning ≤ recovery, and **reserve < critical**, so the critical
  email fires while funding still has spendable headroom instead of after the
  reserve has already halted it.
- Use plain decimal ETH strings inside the JSON (quoted), and prefer a leading
  zero (`0.25`, not `.25`). Amounts must be strings, not JSON numbers. A
  floating-point amount is rejected at boot.

## Steps

1. In the Render dashboard, open `CHAINS` on each of the three services and
   confirm the three values already match. Read the current
   `warningBalanceEth`, `criticalBalanceEth`, `recoveryBalanceEth`, and
   `minimumReserveEth` on every chain in the document. Do not read these from
   `render.yaml`; that file no longer declares them.

2. Choose new values. Keep the reserve high enough to cover gas for the transfers
   you expect, and low enough that it does not strand most of the balance;
   lowering it expands spendable but increases drain exposure. Keep reserve below
   critical. Apply the same numbers to the same chain on every service.

3. Optionally snapshot DB values **read-only** before the change:

```sql
SELECT id, address, enabled,
       warning_balance_wei, critical_balance_wei,
       recovery_balance_wei, minimum_reserve_wei, updated_at
FROM treasuries
WHERE enabled = true;
```

4. Paste the updated `CHAINS` document into **all three** services. Change only
   the threshold strings you intend to change. Leave addresses and RPC URLs
   alone. Do not add a singular `TREASURY_*_ETH` variable beside `CHAINS`.

5. Restart web, treasury-monitor, and wallet-reconciler so each process loads
   the new document and upserts its chains. Because `CHAINS` is `sync: false`,
   a later Blueprint sync will not overwrite this edit. Confirm each service
   boots. A service that fails `INVALID_CONFIGURATION` is still on the old
   process until you fix the document; do not leave the fleet mixed (D23).

6. Confirm via API (operator / read-only):

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq '.data[].thresholds'
```

Thresholds in JSON are wei decimal strings derived from the ETH strings in `CHAINS`.

7. Trigger a treasury check so status/alerts re-evaluate against new bands:

```bash
export TREASURY_ID='…'

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' \
  "$BASE/v1/treasuries/$TREASURY_ID/check" | jq
```

And/or Render → treasury-monitor → **Trigger Run**.

## Verification

- SQL (optional) shows updated `*_balance_wei` / `minimum_reserve_wei` on the
  enabled rows after boot.
- `GET /v1/treasuries` thresholds match the intended policy on every chain.
- All three services start cleanly (bad ordering → `INVALID_CONFIGURATION` at boot).
- Alert behavior: crossing the new warning/critical bands produces the expected
  email transitions on the next successful observation — historical
  `funding_transactions` rows are unchanged (policy/threshold changes do not
  rewrite history).

## Rollback / if this goes wrong

1. Paste the previous `CHAINS` document back onto all three services.
2. Restart all three.
3. Re-check `GET /v1/treasuries` and a manual check/cron run.

A Blueprint sync will not revert a `sync: false` `CHAINS` value. Do not "fix"
a bad document by committing threshold literals into `render.yaml`.

If boot fails validation, the service will not stay up — fix the decimal
strings and ordering in `CHAINS` rather than patching the database. If you
changed a treasury address while editing thresholds, stop and use
[`rotate-treasury-key.md`](./rotate-treasury-key.md) (new address ⇒ new row).
