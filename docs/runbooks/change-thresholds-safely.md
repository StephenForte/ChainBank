# Change thresholds safely

**Use this when:** you need to change treasury warning / critical / recovery /
minimum-reserve ETH thresholds in a hosted environment.

**Do not use this for:** changing the treasury address or signing key — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md). For wallet policy amounts
(`minimumBalanceWei` / `targetBalanceWei` / `maximumTopUpWei`) use
`PUT /v1/wallets/:id/policy`, not this runbook.

## Preconditions

- **Thresholds are version-controlled, not dashboard-set.** All four live as
  literal `value:` entries in [`render.yaml`](../../render.yaml) on both
  `chainbank-web` and `chainbank-treasury-monitor`. Changing them is a code change
  — a pull request — not a Render Environment edit. This is deliberate: CI
  validates the ladder before it can reach a service (see
  `test/unit/config/render-blueprint-thresholds.test.ts`), because a bad value
  fails **every** process at boot, not just funding.
- Repository write access and the ability to merge a PR, plus Render access to
  deploy afterwards.
- Understanding that **configuration is the source of truth**: every web boot and
  cron run calls `registerConfiguredTreasury`, which upserts thresholds onto the
  row matching `(chain_id, address)`. Editing `treasuries.*_wei` in SQL alone is
  **undone on the next boot/cron**.
- Valid ordering, enforced by `assertValidTreasuryThresholds` at startup and by CI:
  critical ≤ warning ≤ recovery. Additionally keep **reserve < critical** — CI
  asserts this — so the critical email fires while funding still has spendable
  headroom instead of after the reserve has already halted it.
- Use plain decimal ETH strings and prefer a leading zero (`0.25`, not `.25`).
  Both parse identically, but the padded form is harder to misread — a `.15`
  intended as `1.5` was set once and would have failed both services at boot.

## Steps

1. Read the current values in [`render.yaml`](../../render.yaml) — they appear
   once per service and must stay identical:

   - `TREASURY_WARNING_BALANCE_ETH`
   - `TREASURY_CRITICAL_BALANCE_ETH`
   - `TREASURY_RECOVERY_BALANCE_ETH`
   - `TREASURY_MINIMUM_RESERVE_ETH`

2. Choose new values. Keep the reserve high enough to cover gas for the transfers
   you expect, and low enough that it does not strand most of the balance;
   lowering it expands spendable but increases drain exposure. Keep reserve below
   critical.

3. Optionally snapshot DB values **read-only** before the change:

```sql
SELECT id, address, enabled,
       warning_balance_wei, critical_balance_wei,
       recovery_balance_wei, minimum_reserve_wei, updated_at
FROM treasuries
WHERE enabled = true;
```

4. Edit `render.yaml`, changing the four values under **both** services to the
   same strings. Run the guard locally before pushing:

```bash
npx vitest run --project unit test/unit/config/render-blueprint-thresholds.test.ts
```

Open a PR. CI re-runs the same check, so an invalid ladder or a mismatch between
the two services fails review rather than the deploy.

5. After merge, sync the Blueprint and redeploy **both** services. Because these
   are now Blueprint-managed `value:` entries, the sync **overwrites** whatever is
   currently set in the Render dashboard for these four keys — that is the intent,
   but confirm the live values afterwards in step 6. Web pre-deploy migrates; both
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

1. Revert the `render.yaml` change (`git revert` the merge, or a follow-up PR
   restoring the previous four values on both services).
2. Sync the Blueprint and redeploy both.
3. Re-check `GET /v1/treasuries` and a manual check/cron run.

For an emergency where a PR round-trip is too slow, you can set the four keys
directly in the Render dashboard to get a service back up — but the next Blueprint
sync will overwrite them, so follow up with a PR that makes `render.yaml` match.

If boot fails validation, the service will not stay up — fix the env decimals /
ordering rather than patching the database. If you changed `TREASURY_ADDRESS`
while editing thresholds, stop and use
[`rotate-treasury-key.md`](./rotate-treasury-key.md) (new address ⇒ new row).
