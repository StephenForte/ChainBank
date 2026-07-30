# Change thresholds safely

**Use this when:** you need to change treasury warning / critical / recovery /
minimum-reserve ETH thresholds in a hosted environment.

**Do not use this for:** changing the treasury address or signing key — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md). For wallet policy amounts
(`minimumBalanceWei` / `targetBalanceWei` / `maximumTopUpWei`) use
`PUT /v1/wallets/:id/policy`, not this runbook.

## Preconditions

- Render Environment access on **both** `chainbank-web` and
  `chainbank-treasury-monitor` (same threshold values on both).
- Understanding that **configuration is the source of truth**: every web boot and
  cron run calls `registerConfiguredTreasury`, which upserts thresholds onto the
  row matching `(chain_id, address)`. Editing `treasuries.*_wei` in SQL alone is
  **undone on the next boot/cron**.
- Valid ordering: critical ≤ warning ≤ recovery (enforced at startup /
  `assertValidTreasuryThresholds`). Plain decimal ETH strings (e.g. `0.25`, not
  `.25` preferred though leading-dot may be accepted — use `0.25`).

## Steps

1. Read current env in Render (web):

   - `TREASURY_WARNING_BALANCE_ETH`
   - `TREASURY_CRITICAL_BALANCE_ETH`
   - `TREASURY_RECOVERY_BALANCE_ETH`
   - `TREASURY_MINIMUM_RESERVE_ETH`

2. Choose new values. Keep reserve high enough that legitimate top-ups remain
   possible after gas; lowering reserve expands spendable but increases drain
   risk.

3. Optionally snapshot DB values **read-only** before change:

```sql
SELECT id, address, enabled,
       warning_balance_wei, critical_balance_wei,
       recovery_balance_wei, minimum_reserve_wei, updated_at
FROM treasuries
WHERE enabled = true;
```

4. Update the four env vars on **`chainbank-web`** and
   **`chainbank-treasury-monitor`** to the same strings.

5. Redeploy **both** services (Manual Deploy). Web pre-deploy migrates; both
   processes upsert thresholds for `TREASURY_ADDRESS`.

6. Confirm via API (operator / read-only):

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq '.data[].thresholds'
```

Thresholds in JSON are wei decimal strings derived from the env ETH values.

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
  enabled row for the configured address after boot.
- `GET /v1/treasuries` thresholds match the intended policy.
- Service starts cleanly (bad ordering → `INVALID_CONFIGURATION` at boot).
- Alert behavior: crossing the new warning/critical bands produces the expected
  email transitions on the next successful observation — historical
  `funding_transactions` rows are unchanged (policy/threshold changes do not
  rewrite history).

## Rollback / if this goes wrong

1. Put the previous env strings back on **web and cron**.
2. Redeploy both.
3. Re-check `GET /v1/treasuries` and a manual check/cron run.

If boot fails validation, the service will not stay up — fix the env decimals /
ordering rather than patching the database. If you changed `TREASURY_ADDRESS`
while editing thresholds, stop and use
[`rotate-treasury-key.md`](./rotate-treasury-key.md) (new address ⇒ new row).
