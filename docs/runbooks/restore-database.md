# Restore database

**Use this when:** hosted Postgres data is lost, corrupted, or must be rolled
back to a Render backup / point-in-time restore.

**Do not use this for:** applying schema changes forward — use the normal
deploy path (`preDeployCommand: npm run db:migrate:built` in `render.yaml`).
For credential incidents after a partial leak, restoring a backup does **not**
replace [`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md).

## Preconditions

- Render account permission on `chainbank-db` (Blueprint database name in
  `render.yaml`).
- Operator who can redeploy `chainbank-web` and `chainbank-treasury-monitor`.
- Acceptance that restore is a **provider operation**: this repository has **no**
  backup/restore script (Known gaps in [`README.md`](./README.md)).
- During restore, treat funding as unsafe — flip the kill switch first
  ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).

## Steps

1. **Stop signing** on `chainbank-web` (`FUNDING_KILL_SWITCH=true` + redeploy).
   Optionally suspend the treasury-monitor cron (Render → cron → suspend) so it
   does not write observations mid-restore.

2. Render Dashboard → **`chainbank-db`** → **Backups** (wording may vary by
   Render plan). Select the recovery point and run Render’s **Restore** flow
   for that Postgres instance. Use only the dashboard/provider procedure — do
   not invent `pg_dump` / `pg_restore` flags here unless your team already has a
   separately reviewed offline runbook for External URL access.

3. After Render reports the database available, confirm web still has
   `DATABASE_URL` (from Blueprint `fromDatabase`) and a current
   `DATABASE_SSL_CA` leaf pin. If TLS fails after restore/host change, re-run
   from the web Shell (see [`deploy-render-phase0.md`](./deploy-render-phase0.md)):

```bash
cd ~/project/src
node scripts/print-database-ca.mjs
```

Paste the escaped PEM into `DATABASE_SSL_CA` on **web and cron**, then
redeploy both.

4. Redeploy **`chainbank-web`**. Pre-deploy runs `npm run db:migrate:built`,
   which applies any migrations newer than the backup’s schema. Confirm migrate
   logs succeed and show `databaseTlsPinMode: "leaf"`.

5. Redeploy or Trigger Run **`chainbank-treasury-monitor`**.

6. Smoke:

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'   # token that exists in the restored api_credentials

curl -s "$BASE/health/ready" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
```

If credentials in the backup are stale/unknown, issue a new operator token
against the restored DB (`npm run credential:issue` — see
[`deploy-render-phase0.md`](./deploy-render-phase0.md) §4).

7. Reconcile env vs data: `TREASURY_ADDRESS` / thresholds still re-upsert on boot
   into `treasuries`. If the backup is older than a key rotation, follow
   [`rotate-treasury-key.md`](./rotate-treasury-key.md) carefully (orphan
   enabled rows).

8. Only after readiness and treasury list look correct, clear the kill switch
   when you intentionally re-arm funding.

## Verification

- `/health/ready` → database component `ok` (HTTP 200 unless DB failed).
- Migrate/boot logs: TLS leaf mode, no migrate errors.
- `GET /v1/treasuries` returns expected enabled treasury.
- Cron heartbeat eventually present:
  `heartbeats[]` with `serviceRole: "treasury-monitor"` (see
  [`verify-cron-execution.md`](./verify-cron-execution.md)).
- Spot-check that funding/audit history you expected from the backup era is
  present — never delete rows to “clean” a restore.

## Rollback / if this goes wrong

- A bad restore usually means restoring a **different** Render backup point
  (provider limitation — ChainBank cannot roll forward application rows once
  overwritten).
- If migrate fails after restore, fix forward with a good deploy of `main`; do
  not hand-edit `drizzle` migration files.
- If TLS pin mismatches after restore, update `DATABASE_SSL_CA` before chasing
  application bugs.
- Keep `FUNDING_KILL_SWITCH=true` until data and treasury address alignment are
  verified.
