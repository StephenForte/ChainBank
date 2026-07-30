# Verify cron execution

**Use this when:** you need to confirm `chainbank-treasury-monitor` ran, diagnose
a missed daily check, or prove alert evaluation is still heartbeat-healthy.

**Do not use this for:** emergency funding stop —
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md). For
threshold value changes —
[`change-thresholds-safely.md`](./change-thresholds-safely.md).

## Preconditions

- Render access to cron service `chainbank-treasury-monitor` (`render.yaml`:
  schedule `0 13 * * *` UTC, start command `npm run cron:treasury-monitor`).
- Optional operator token for `/health/ready` cross-check (that route is
  unauthenticated, but treasury APIs are not).

## Steps

1. Confirm schedule and recent runs: Render → **`chainbank-treasury-monitor`** →
   **Logs** / run history. Look for exit code **0**.

2. Success log lines from `src/jobs/treasury-monitor.ts` include:

   - `Treasury monitor run started`
   - `Treasury alert evaluation completed` (when balance was observed)
   - `Treasury observation recorded`
   - `Treasury monitor run succeeded`

   Failure paths exit non-zero (e.g. unreadable treasury throws after heartbeat
   attempt patterns in logs — treat non-zero as failed run).

3. Trigger a manual run: Render → cron → **Trigger Run**. Wait for completion.

4. Check readiness heartbeats (no auth):

```bash
export BASE='https://chainbank-web.onrender.com'

curl -s "$BASE/health/ready" | jq '.heartbeats'
```

Expect an entry like:

```json
{
  "serviceRole": "treasury-monitor",
  "lastSeenAt": "2026-07-30T13:00:12.000Z"
}
```

`lastSeenAt` should be recent relative to the run you triggered. Web also
heartbeats as `serviceRole: "web"` on startup.

5. Optional SQL (read-only):

```sql
SELECT service_role, last_seen_at, last_operation_id, detail
FROM service_heartbeats
WHERE service_role IN ('treasury-monitor', 'web')
ORDER BY last_seen_at DESC;
```

`detail` for a successful cron path includes `event: 'run'`, `outcome`, and
`treasuryId` (JSON in `detail`).

6. Optional: confirm observation via API:

```bash
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq '.data[].lastCheckedAt'
```

## Verification

- Manual Trigger Run exits 0.
- `/health/ready` shows fresh `treasury-monitor` `lastSeenAt`.
- Logs contain `Treasury observation recorded` (or a clear non-zero failure if
  RPC/DB is down — do not treat RPC failure as a zero balance).

## Rollback / if this goes wrong

| Symptom                                              | Likely cause                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Cron never starts                                    | Suspended cron, Blueprint mis-sync, or build failure (`npm ci --include=dev && npm run build`) |
| TLS / DB errors on boot                              | Stale `DATABASE_SSL_CA` — [`deploy-render-phase0.md`](./deploy-render-phase0.md)               |
| `Treasury balance could not be read` / non-zero exit | `RPC_UNAVAILABLE` / bad `CHAIN_RPC_URL`                                                        |
| Heartbeat missing after “success”                    | Looking at wrong DB, or web pointing at a different database than cron                         |
| Email missing but observation ok                     | Resend / `EMAIL_*` vars on the **monitor** service; alert transition was `none`                |

There is nothing to “roll back” for a verification check. Fix env / RPC / TLS
and Trigger Run again.
