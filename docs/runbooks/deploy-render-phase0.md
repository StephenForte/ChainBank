# Deploy ChainBank Phase 0 to Render

Phase 0 hosts a **read-only** web service, a **daily treasury-monitor cron**, and **shared Postgres**. No service receives a treasury private key.

## Prerequisites

- GitHub repo `StephenForte/ChainBank` on `main` with current Blueprint (`render.yaml`)
- Render account with permission to create Blueprints
- Values ready:
  - Sepolia RPC URL (`CHAIN_RPC_URL`)
  - Hot-wallet treasury address (`TREASURY_ADDRESS`)
  - Threshold ETH strings (warning / critical / recovery / reserve)
  - Resend API key + from address + operator recipient list
- Confirm you will **not** set `TREASURY_PRIVATE_KEY` anywhere

## 1. Create the Blueprint

1. Open [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect the `StephenForte/ChainBank` repository, branch `main`.
3. Confirm Render detected `render.yaml`.
4. When prompted for `sync: false` variables, enter:

| Variable | Service | Notes |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | web | Use `https://chainbank-web.onrender.com` (adjust if Render assigns a different name), then confirm after first deploy |
| `CHAIN_RPC_URL` | web + cron | Real JSON-RPC URL, not etherscan.io |
| `TREASURY_ADDRESS` | web + cron | Hot wallet only |
| `TREASURY_WARNING_BALANCE_ETH` | web + cron | e.g. `1` |
| `TREASURY_CRITICAL_BALANCE_ETH` | web + cron | e.g. `0.25` |
| `TREASURY_RECOVERY_BALANCE_ETH` | web + cron | e.g. `2` |
| `TREASURY_MINIMUM_RESERVE_ETH` | web + cron | e.g. `0.5` |
| `RESEND_API_KEY` | web only | |
| `EMAIL_FROM_ADDRESS` | web only | Verified sender in Resend |
| `EMAIL_OPERATOR_RECIPIENTS` | web only | Comma-separated |

5. Create the Blueprint and wait for the first web deploy.

Expected deploy sequence for `chainbank-web`:

1. `npm ci --include=dev && npm run build`
2. `npm run db:migrate:built` (pre-deploy)
3. `npm start`

## 2. Confirm least privilege

On **both** `chainbank-web` and `chainbank-treasury-monitor`:

- `FUNDING_ENABLED=false`
- **No** `TREASURY_PRIVATE_KEY`
- Cron must **not** have `RESEND_API_KEY`

## 3. Fix `PUBLIC_BASE_URL` if needed

1. Copy the live web URL from the Render service page.
2. Set `PUBLIC_BASE_URL` to that exact origin (no trailing slash).
3. Manual deploy if Render does not pick up the change automatically.

## 4. Issue an operator credential

Prefer issuing from your laptop against the Render database so the raw token never appears in hosted logs:

1. In Render → `chainbank-db` → copy the **External Database URL**.
2. Locally (do not commit this):

```bash
export DATABASE_URL='postgres://…external-render-url…'
# monitor role is enough for the issuer script
export CHAIN_ID=11155111
export CHAIN_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
export TREASURY_ADDRESS='0xYourHotWallet'
export TREASURY_WARNING_BALANCE_ETH=1
export TREASURY_CRITICAL_BALANCE_ETH=0.25
export TREASURY_RECOVERY_BALANCE_ETH=2
export TREASURY_MINIMUM_RESERVE_ETH=0.5
export CHAINBANK_ENVIRONMENT=local

npm run credential:issue -- --name "operator-render" --role operator
```

3. Store the `cb_…` token in a password manager. It is shown once.

Alternative: Render Shell on the web service with `npx tsx scripts/issue-credential.ts --name operator-render --role operator` (token will appear in that shell session).

## 5. Smoke checks

```bash
export BASE='https://chainbank-web.onrender.com'   # your URL
export TOKEN='cb_…'

curl -s "$BASE/health/ready" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq

export TREASURY_ID='…from list…'
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' \
  "$BASE/v1/treasuries/$TREASURY_ID/check" | jq

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' \
  "$BASE/v1/admin/email/test" | jq
```

Dashboard: open `$BASE/` → paste token → **Check now** / **Send test email**.

Cron:

1. Open `chainbank-treasury-monitor` → **Trigger Run**.
2. Confirm exit 0 in logs.
3. Re-check `/health/ready` — heartbeats should include both `web` and `treasury-monitor`.

## Success criteria

- `/health/ready` reports database and rpc `ok` (or rpc `degraded` only if the public RPC is temporarily down)
- Treasury check returns `outcome: "observed"`
- Test email arrives
- Both service heartbeats present
- Still no signing path / no ETH movement

## Rollback

- Disable auto-deploy on the Blueprint services
- Redeploy the previous successful deploy from Render history
- Or set a temporary kill by stopping the web service (Phase 0 has no funding to disable beyond `FUNDING_ENABLED=false`)

## Common failures

| Symptom | Likely cause |
| --- | --- |
| `vite: not found` / `tsc: not found` | Build omitted devDependencies; Blueprint must use `npm ci --include=dev` |
| Build fails on Vite / `index.html` | Dashboard sources missing from `main` |
| Migrate fails | Postgres not ready or `DATABASE_URL` missing |
| RPC failed / degraded | `CHAIN_RPC_URL` is an explorer URL or blocked |
| `INVALID_CREDENTIAL` | Token not issued against this database |
| Cron missing email vars | Expected — monitor role does not load email config |
