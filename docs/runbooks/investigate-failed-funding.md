# Investigate failed funding

**Use this when:** `POST /v1/wallets/:id/ensure-funded` returned an error or a
non-success `data.status`, or you see a concerning row in
`GET /v1/funding-transactions` / the dashboard funding table.

**Do not use this for:** emergency halt of all signing — use
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md). For
in-flight nonce / `submission_unknown` recovery specifically — continue here for
diagnosis, then
[`recover-stuck-pending-nonce.md`](./recover-stuck-pending-nonce.md).

## Preconditions

- Operator or read-only API credential (project-service only sees in-scope rows).
- The `operationId`, `managedWalletId`, error `code`, or transaction `status` from
  the failing call or dashboard.
- Optional: Render web logs filtered by that operation / correlation id.

## Gather facts first

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

# By operation
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-operations/<operation-uuid>" | jq

# Recent transactions (filter as needed)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-transactions?limit=50&offset=0" | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-transactions?status=failed&limit=50" | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-transactions?managedWalletId=<wallet-uuid>&limit=50" | jq
```

Read-only SQL if the API is down:

```sql
SELECT id, status, error_code, error_summary, started_at, completed_at,
       project_id, environment_id, idempotency_key
FROM funding_operations
WHERE id = '<operation-uuid>';

SELECT id, operation_id, treasury_id, managed_wallet_id, amount_wei,
       transaction_hash, nonce, status, error_code,
       created_at, submitted_at, confirmed_at
FROM funding_transactions
WHERE operation_id = '<operation-uuid>'
   OR managed_wallet_id = '<wallet-uuid>'
ORDER BY created_at DESC
LIMIT 20;
```

Do **not** `DELETE` funding or audit rows.

---

## Diagnose from ensure-funded / HTTP error code

| Code                                         | HTTP | Meaning                                                                                                       | What to do                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUNDING_DISABLED`                           | 403  | `FUNDING_ENABLED=false` or `FUNDING_KILL_SWITCH=true` (public text differs: disabled vs temporarily disabled) | Check Render env on the service that refused (`chainbank-web`, or `chainbank-wallet-reconciler` for cron runs). Kill switch / enable flips need **redeploy/restart** to take effect. If nobody flipped it, see “Gates reverting on their own” below. |
| `FUNDING_BLOCKED_RESERVE`                    | 409  | Top-up would breach reserve + gas (+ in-flight)                                                               | [`replenish-treasury.md`](./replenish-treasury.md); inspect in-flight rows that still count against spendable.                                                                                                                                       |
| `PENDING_FUNDING_EXISTS`                     | 409  | Wallet already has in-flight tx (`created` / `submitted` / `submission_unknown`)                              | [`recover-stuck-pending-nonce.md`](./recover-stuck-pending-nonce.md). Do not retry with a new idempotency key expecting a second send.                                                                                                               |
| `ENTITY_DISABLED`                            | 403  | Project, environment, wallet, or treasury `enabled = false`                                                   | Re-enable via `PATCH /v1/projects/:id`, `PATCH /v1/environments/:id`, or `PATCH /v1/wallets/:id` with `{ "enabled": true }` when intentional; treasury enable is SQL-only (Known gaps).                                                              |
| `SIGNER_CHAIN_MISMATCH`                      | 503  | RPC chain id ≠ configured `CHAIN_ID`                                                                          | Fix `CHAIN_RPC_URL` / `CHAIN_ID`; refuse to sign until matched.                                                                                                                                                                                      |
| `SIGNER_UNAVAILABLE`                         | 503  | Funding enabled but signer missing/unusable in this process                                                   | Confirm `TREASURY_PRIVATE_KEY` on the signing-capable services (**web** and **wallet-reconciler**, never the monitor), structurally valid, and `FUNDING_ENABLED=true` for that role.                                                                                                                           |
| `GAS_ESTIMATION_FAILED`                      | 503  | Gas estimation failed closed (no constant fallback)                                                           | Check RPC health; retry after RPC recovers.                                                                                                                                                                                                          |
| `RPC_UNAVAILABLE`                            | 503  | Balance read or RPC dependency failed                                                                         | Never treat as zero balance. Fix RPC; retry.                                                                                                                                                                                                         |
| `INVALID_CONFIGURATION`                      | 400  | Includes signer/treasury address mismatch (`assertSignerMatchesTreasury`)                                     | Public: `Funding is unavailable because the treasury signer is misconfigured.` → [`rotate-treasury-key.md`](./rotate-treasury-key.md).                                                                                                               |
| `SCOPE_DENIED` / `INSUFFICIENT_ROLE`         | 403  | Credential cannot fund this wallet                                                                            | Fix scopes or use an operator token.                                                                                                                                                                                                                 |
| `CREDENTIAL_DISABLED` / `INVALID_CREDENTIAL` | 401  | Auth failure (disabled/revoked credentials share the invalid public message)                                  | [`rotate-service-token.md`](./rotate-service-token.md) / compromise runbook.                                                                                                                                                                         |
| `WALLET_NOT_FOUND` / `TREASURY_NOT_FOUND`    | 404  | Missing wallet or no enabled treasury on chain                                                                | Register wallet or fix treasury enablement / address.                                                                                                                                                                                                |
| `TRANSACTION_REVERTED`                       | 409  | Receipt status failed on-chain                                                                                | Treat as terminal for that tx; investigate gas/recipient; do not assume funds moved.                                                                                                                                                                 |
| `TRANSACTION_REPLACED`                       | 409  | Same nonce superseded                                                                                         | Confirm replacement on explorer; do not resubmit blindly.                                                                                                                                                                                            |
| `TRANSACTION_DROPPED`                        | 409  | Tracker concluded drop with evidence rules                                                                    | Confirm on explorer before retrying ensure-funded.                                                                                                                                                                                                   |

Ensure-funded success body uses `data.status`: `no-op` | `funded` | `pending` |
`blocked` | `failed`. On `blocked`, check `data.reasonCode`
(`FUNDING_BLOCKED_RESERVE` or `FUNDING_DISABLED`).

### Gates reverting on their own

`FUNDING_DISABLED` with nobody admitting to flipping anything has one known
non-human cause: a **Blueprint sync**. Render reapplies every env var declared
with a literal `value:` in `render.yaml` whenever that file changes — for any
reason, on every service in the Blueprint, overwriting dashboard edits. Vars
declared `sync: false` are left alone.

This happened on 2026-08-11: a commit adding `FUNDING_HEALTH_TOKEN` to the web
service re-applied `FUNDING_ENABLED=false` to `chainbank-wallet-reconciler`,
which had been enabled from the dashboard. Unattended funding stopped for three
scheduled runs (~18 h) and nothing alerted, because a policy stop is exit 0.

Both funding gates are now `sync: false` on the signing-capable services, and
CI enforces it. To confirm a suspected revert:

- Render → the service → **Events**: look for a deploy with trigger
  **`blueprint sync`** shortly before the first refusal.
- Compare with the last known-good run: the reconciler logs `fundingEnabled` at
  web boot and `exitKind` per run.

Reverting still needs a restart to take effect — the run that first sees your
fix may be the one _after_ the one you triggered.

---

## Diagnose from `funding_transactions.status`

| Status               | Terminal?      | Operator meaning                                                                                                                                                                                                              |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`            | No (in-flight) | Row reserved before/during submit path; still blocks duplicates.                                                                                                                                                              |
| `submitted`          | No (in-flight) | Hash recorded. `GET /v1/funding-operations/:id` resumes receipt tracking when still `submitted`.                                                                                                                              |
| `submission_unknown` | No (in-flight) | Ambiguous broadcast; **no hash**. API surfaces operation as `pending` + `reason: "submission-unconfirmed"`. Automated resolution deferred to Phase 4. → [`recover-stuck-pending-nonce.md`](./recover-stuck-pending-nonce.md). |
| `confirmed`          | Yes            | Success path; explorer link should match `transaction_hash`.                                                                                                                                                                  |
| `reverted`           | Yes            | On-chain failure (`TRANSACTION_REVERTED`).                                                                                                                                                                                    |
| `replaced`           | Yes            | Nonce reused / replaced (`TRANSACTION_REPLACED`).                                                                                                                                                                             |
| `dropped`            | Yes            | Dropped with tracker evidence (`TRANSACTION_DROPPED`).                                                                                                                                                                        |
| `failed`             | Yes            | Pre-broadcast / rejected before unknown-submit path (`PRE_BROADCAST_ERROR_CODES`). Safe to investigate as “never intentionally left ambiguous.”                                                                               |

## Verification

You are done investigating when you can state: the exact `error.code` or tx
`status`, whether funds could still be in flight, and the next runbook (replenish,
kill switch, nonce recovery, key rotation, or wait for RPC).

## Rollback / if this goes wrong

- Do not mark `submission_unknown` as `failed` in SQL to “unblock” a wallet —
  that reopens the duplicate gate while ETH may still be in the mempool
  (`tasks/SECURITY-REVIEW-T1.5.md`).
- Do not retry ensure-funded with a new idempotency key to force a second
  transfer while an in-flight row exists; expect `PENDING_FUNDING_EXISTS`.
- If blast radius is unclear, flip the kill switch first
  ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).
