# Disable all automated funding (emergency stop)

**Use this when:** you must stop every treasury signing path **now** (suspected
key leak, runaway top-ups, bad deploy, unknown in-flight risk).

**Do not use this for:** disabling one project or wallet — use
`PATCH /v1/projects/:id`, `PATCH /v1/environments/:id`, or
`PATCH /v1/wallets/:id` with `{ "enabled": false }`. For a single leaked API
token — [`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md).

## Preconditions

- Render access to the Environment of **both signing-capable services**:
  **`chainbank-web`** and **`chainbank-wallet-reconciler`**. Stopping only web
  leaves the reconciler cron signing unattended on its six-hourly schedule —
  it carries `TREASURY_PRIVATE_KEY` and funds without any request.
- Willingness to **redeploy or restart** each. `FUNDING_KILL_SWITCH` is read at
  process boot via `loadConfig` — there is **no runtime toggle endpoint**. Until
  the new process starts, the old process keeps the previous value and **can
  still sign**.

## Steps

Do web first (it signs on demand), then the reconciler (it signs on a timer).

1. Render Dashboard → **`chainbank-web`** → **Environment**.
2. Set:

   | Variable              | Value  |
   | --------------------- | ------ |
   | `FUNDING_KILL_SWITCH` | `true` |

   The key is declared `sync: false` in `render.yaml`, so it exists on the
   service and the dashboard value is authoritative. Add it if missing.

3. **Manual Deploy** (or restart) **`chainbank-web`** immediately. Wait until
   the new deploy is live.
4. Repeat steps 1–3 for **`chainbank-wallet-reconciler`**. A cron has no
   long-lived process, so the next scheduled run picks up the new value — but
   redeploy anyway rather than reasoning about whether a run is in flight.
   Confirm the next run logs `exitKind: policy-disabled`.
5. Optional belt-and-suspenders: set `FUNDING_ENABLED=false` on both. Same
   restart requirement. Prefer the kill switch for “temporary emergency”
   wording in API errors.

> **Do not merge a `render.yaml` change while the kill switch is on** unless you
> have re-checked both services afterwards. Any edit to that file — including
> one touching an unrelated service — makes Render re-sync the whole Blueprint
> and reapply every literal `value:`. The funding gates are `sync: false`
> specifically so a sync cannot clear them, but a PR that reintroduces a literal
> would silently re-arm funding mid-incident. CI blocks that
> (`test/unit/config/render-blueprint-thresholds.test.ts`); this note is the
> reason the check exists.

## What keeps working

These stay up; you are **not** taking monitoring offline:

- `GET /health/live`, `GET /health/ready`
- `GET /v1/treasuries`, `POST /v1/treasuries/:id/check`
- Wallet / project / environment reads and admin mutations that do not sign
- `GET /v1/funding-transactions`, `GET /v1/funding-operations/:id` (read / track)
- `POST /v1/admin/email/test`
- `chainbank-treasury-monitor` cron (read-only balance + alerts; no signing key)
- `chainbank-wallet-reconciler` cron still **runs** — it exits 0 with
  `errorCode: FUNDING_DISABLED` and assesses no wallets. Render will keep
  reporting “run finished successfully”; that is the halted state, not a
  working one.

## What stops

- `POST /v1/wallets/:id/ensure-funded` → `FUNDING_DISABLED`
  (public: `Funding is temporarily disabled.` when the kill switch is active)
- `TreasurySigner.sendNativeTransfer` → same code if anything reached it
- Dispatch path refuses before submit with `FUNDING_DISABLED`

## Verification

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"emergency-probe-1"}' \
  "$BASE/v1/wallets/<wallet-uuid>/ensure-funded" | jq
# Expect HTTP 403, error.code = "FUNDING_DISABLED"

curl -s "$BASE/health/ready" | jq
# Expect database ok; heartbeats still present
```

Check env in Render on **both** services: `FUNDING_KILL_SWITCH=true` on the
running deploy. For the reconciler, also confirm the next scheduled run logs:

```
"exitKind":"policy-disabled","errorCode":"FUNDING_DISABLED","walletsAssessed":0
```

## Rollback

1. Set `FUNDING_KILL_SWITCH=false` (and restore `FUNDING_ENABLED` only if
   intentionally re-arming) on **both** signing-capable services.
2. Redeploy/restart **`chainbank-web`** and **`chainbank-wallet-reconciler`**.
3. Confirm a controlled ensure-funded or that funding remains gated as you
   intend. For the reconciler, confirm the next run reports `exitKind: success`
   with a non-zero `walletsAssessed` — a still-disabled cron looks identical to
   a healthy one in Render's job list.

If the treasury key itself is compromised, keep the kill switch on and proceed
to [`rotate-treasury-key.md`](./rotate-treasury-key.md).
