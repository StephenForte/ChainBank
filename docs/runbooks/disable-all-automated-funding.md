# Disable all automated funding (emergency stop)

**Use this when:** you must stop every treasury signing path **now** (suspected
key leak, runaway top-ups, bad deploy, unknown in-flight risk).

**Do not use this for:** disabling one project or wallet — use
`PATCH /v1/projects/:id`, `PATCH /v1/environments/:id`, or
`PATCH /v1/wallets/:id` with `{ "enabled": false }`. For a single leaked API
token — [`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md).

## Preconditions

- Render access to **`chainbank-web`** Environment (signing process today).
- Willingness to **redeploy or restart** web. `FUNDING_KILL_SWITCH` is read at
  process boot via `loadConfig` — there is **no runtime toggle endpoint**. Until
  the new process starts, the old process keeps the previous value and **can
  still sign**.

## Steps

1. Render Dashboard → **`chainbank-web`** → **Environment**.
2. Set:

   | Variable              | Value  |
   | --------------------- | ------ |
   | `FUNDING_KILL_SWITCH` | `true` |

   (`FUNDING_KILL_SWITCH` is not in `render.yaml`; add the key if missing.)

3. **Manual Deploy** (or restart) **`chainbank-web`** immediately. Wait until
   the new deploy is live.
4. Optional belt-and-suspenders: set `FUNDING_ENABLED=false` on web (and any
   future signing service). Same restart requirement. Prefer the kill switch for
   “temporary emergency” wording in API errors.

## What keeps working

These stay up; you are **not** taking monitoring offline:

- `GET /health/live`, `GET /health/ready`
- `GET /v1/treasuries`, `POST /v1/treasuries/:id/check`
- Wallet / project / environment reads and admin mutations that do not sign
- `GET /v1/funding-transactions`, `GET /v1/funding-operations/:id` (read / track)
- `POST /v1/admin/email/test`
- `chainbank-treasury-monitor` cron (read-only balance + alerts; no signing key)

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

Check web env in Render: `FUNDING_KILL_SWITCH=true` on the running deploy.

## Rollback

1. Set `FUNDING_KILL_SWITCH=false` (and restore `FUNDING_ENABLED` only if
   intentionally re-arming).
2. Redeploy/restart **`chainbank-web`**.
3. Confirm a controlled ensure-funded or that funding remains gated as you
   intend.

If the treasury key itself is compromised, keep the kill switch on and proceed
to [`rotate-treasury-key.md`](./rotate-treasury-key.md).
