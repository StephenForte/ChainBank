# Verify cron execution

**Use this when:** you need to confirm `chainbank-treasury-monitor` or
`chainbank-wallet-reconciler` ran, diagnose a missed schedule, or prove
heartbeats still show shared-DB health on `/health/ready`.

**Do not use this for:** emergency funding stop —
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md). For
threshold value changes —
[`change-thresholds-safely.md`](./change-thresholds-safely.md).

## Preconditions

- Render access to the cron service under test:
  - **`chainbank-treasury-monitor`** — schedule `0 13 * * *` UTC, start
    `npm run cron:treasury-monitor` (read-only; no signing key).
  - **`chainbank-wallet-reconciler`** — schedule `0 */6 * * *` UTC, start
    `npm run cron:wallet-reconciler` (signing-capable; may hold
    `TREASURY_PRIVATE_KEY` when funding is armed).
- Optional operator token for treasury APIs ( `/health/ready` is unauthenticated).

## Steps — treasury monitor

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

## Steps — wallet reconciler

> **Gotchas confirmed operating this cron live (2026-08-02). Read before
> concluding a green run means anything.**
>
> - **Adding a cron service to the Blueprint does not materialize its
>   `sync: false` variables.** When `chainbank-wallet-reconciler` was added,
>   Render synced the service but left all eight `sync: false` vars unset; they
>   had to be entered by hand (copy the values from `chainbank-web`, except
>   `TREASURY_PRIVATE_KEY`, which belongs on web + reconciler and **never** on
>   `chainbank-treasury-monitor`). A service that boots and exits non-zero
>   immediately after a Blueprint sync is almost always this.
> - **`reconciliation_enabled` defaults to `false` on every managed wallet**, so
>   a sweep assesses **zero** wallets until one is deliberately registered with
>   it true. A successful run over an empty set is not evidence that
>   reconciliation works — check `wallets_assessed` on the run row, not just the
>   exit code.
> - **`RECONCILE_OUTGOING_LOOKBACK_BLOCKS` may have been manually lowered in
>   hosted config before TX.9 landed. Restoring it to `20000` is now safe.** TX.9
>   made the scan incremental (it resumes from a per-treasury watermark rather
>   than re-scanning a fixed window) and made the `submission_unknown` nonce hunt
>   bisect instead of sweeping. The value is now a **per-run maximum**, not
>   "always scan this much."
> - **After restoring it, expect the first runs to report
>   `outgoing_scan_status: 'incomplete'` with an `outgoing_scan_coverage_behind`
>   finding. This is correct, not a regression.** The watermark is draining a
>   backlog accumulated while the scan was capped short; windows advance
>   forward-contiguously so nothing is skipped, and it catches up at roughly 11×
>   real time. Per C15 an incomplete scan alone does not page. The run reads
>   `complete` again once the window reaches the tip.

1. Confirm schedule and recent runs: Render → **`chainbank-wallet-reconciler`** →
   **Logs** / run history.

2. Exit semantics (T4.2 / C14 amendment):

   | Situation                                       | `error_code` on run row | Process exit | Render     |
   | ----------------------------------------------- | ----------------------- | ------------ | ---------- |
   | Sweep finished without run-level failure        | null                    | **0**        | succeeded  |
   | `FUNDING_ENABLED=false` or kill switch          | `FUNDING_DISABLED`      | **0**        | succeeded  |
   | DB / RPC / signer / unhandled run-level failure | other code              | **1**        | **failed** |

   A kill switch left on for a week must **not** produce twenty-eight failed-run
   pages — that path is policy, recorded on the run row, exit zero.

3. Success / policy log lines from `src/jobs/wallet-reconciler.ts` include:

   - `Wallet reconciler run started`
   - `Prior reconciliation runs aborted before finish` (only if any
     `finished_at IS NULL` rows exist — treat those as aborted, not clean. Since
     TX.9 / migration `0005`, `outgoing_scan_status` defaults to `not-run`, so a
     newly aborted row no longer reads clean. Rows written **before** `0005` may
     still show a stale `complete`, so `finished_at IS NULL` remains the
     authoritative signal for aborted runs.)
   - `Wallet reconciler run completed` **or**
     `…skipped by funding policy…; exiting zero`
   - `Wallet reconciler run finished` with `exitCode: 0`

   Malfunction: `Wallet reconciler run finished with run-level malfunction` /
   `Wallet reconciler run failed` with `exitCode: 1`.

4. Trigger a manual run: Render → cron → **Trigger Run**. Wait for completion.

5. Optional SQL (read-only) for the latest run:

```sql
SELECT run_id, started_at, finished_at, error_code, wallets_assessed,
       wallets_funded, wallets_failed, outgoing_scan_status
FROM reconciliation_runs
ORDER BY started_at DESC
LIMIT 5;
```

## Shared readiness heartbeats

Check readiness heartbeats (no auth):

```bash
export BASE='https://chainbank-web.onrender.com'

curl -s "$BASE/health/ready" | jq '.heartbeats'
```

Expect entries like:

```json
[
  { "serviceRole": "web", "lastSeenAt": "…" },
  { "serviceRole": "treasury-monitor", "lastSeenAt": "…" },
  { "serviceRole": "wallet-reconciler", "lastSeenAt": "…" }
]
```

`lastSeenAt` should be recent relative to the run you triggered. Web also
heartbeats as `serviceRole: "web"` on startup.

Optional SQL (read-only):

```sql
SELECT service_role, last_seen_at, last_operation_id, detail
FROM service_heartbeats
WHERE service_role IN ('treasury-monitor', 'wallet-reconciler', 'web')
ORDER BY last_seen_at DESC;
```

`detail` for a successful reconciler path includes `event: 'run'`, `exitKind`,
and `runId`. Monitor success includes `event: 'run'`, `outcome`, and `treasuryId`.

## Optional: confirm treasury observation via API (monitor)

```bash
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq '.data[].lastCheckedAt'
```

## Verification

- Manual Trigger Run exits as expected (0 for success/policy; 1 only for
  malfunction).
- `/health/ready` shows fresh `treasury-monitor` and/or `wallet-reconciler`
  `lastSeenAt`.
- Monitor logs contain `Treasury observation recorded` (or a clear non-zero
  failure if RPC/DB is down — do not treat RPC failure as a zero balance).
- Reconciler writes a finished `reconciliation_runs` row; aborted prior rows
  (if any) were logged at startup.

## Rollback / if this goes wrong

| Symptom                                              | Likely cause                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cron never starts                                    | Suspended cron, Blueprint mis-sync, or build failure (`npm ci --include=dev && npm run build`)   |
| Newly added cron exits non-zero straight away        | `sync: false` vars not materialized by the Blueprint sync — enter all eight by hand              |
| Reconciler: run succeeds but `wallets_assessed` is 0 | No wallet has `reconciliation_enabled = true` — not a platform failure, and not a success either |
| Reconciler: run never finishes / cancelled           | Outgoing scan at too high a `RECONCILE_OUTGOING_LOOKBACK_BLOCKS` (TX.9) — lower it               |
| TLS / DB errors on boot                              | Stale `DATABASE_SSL_CA` — [`deploy-render-phase0.md`](./deploy-render-phase0.md)                 |
| Monitor: balance unread / non-zero exit              | `RPC_UNAVAILABLE` / bad `CHAIN_RPC_URL`                                                          |
| Reconciler: `SIGNER_UNAVAILABLE` / non-zero exit     | `FUNDING_ENABLED=true` without valid `TREASURY_PRIVATE_KEY` on **reconciler** (not monitor)      |
| Reconciler: exit 0 with `FUNDING_DISABLED`           | Expected when funding off or kill switch on — not a platform failure                             |
| Heartbeat missing after “success”                    | Looking at wrong DB, or web pointing at a different database than cron                           |
| Email missing but monitor observation ok             | Resend / `EMAIL_*` vars on the **monitor** service; alert transition was `none`                  |

There is nothing to “roll back” for a verification check. Fix env / RPC / TLS
and Trigger Run again.
