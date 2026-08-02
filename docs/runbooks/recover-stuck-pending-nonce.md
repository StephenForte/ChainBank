# Recover stuck / pending nonce

**Use this when:** a managed wallet cannot be funded because an in-flight
funding transaction is still open (`created`, `submitted`, or
`submission_unknown`), often surfaced as `PENDING_FUNDING_EXISTS`, or reserve
math stays depressed because in-flight amounts still count.

**Do not use this for:** general funding triage without an in-flight row — start
at [`investigate-failed-funding.md`](./investigate-failed-funding.md). For
emergency stop — [`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Preconditions

- Operator (or read-only) API access.
- Comfort using a block explorer for the treasury address and nonce.
- Understanding that reconciliation settles `submission_unknown` only on
  **positive on-chain evidence** (confirmed nonce advanced past the reserved
  slot, then promote or mark replaced). There is no operator endpoint that
  clears the gate by hand.

## What the system does today

- In-flight statuses: `created` | `submitted` | `submission_unknown`.
- Per-wallet gate: a second ensure-funded while in-flight → `PENDING_FUNDING_EXISTS`.
- Reserve: `sumInFlightAmountWeiByTreasury` includes those statuses.
- `GET /v1/funding-operations/:id`:
  - `submitted` → may resume `trackTransaction` (wait for receipt / timeout → still
    `pending`).
  - `submission_unknown` → returns `status: "pending"`,
    `reason: "submission-unconfirmed"`; **does not** call the receipt tracker (no
    hash). Nested `transaction.status` remains `"submission_unknown"`.

## `BROADCAST_INTENT` (TX.10 residual wedge)

A row with:

| Field              | Value                   |
| ------------------ | ----------------------- |
| `status`           | `submission_unknown`    |
| `error_code`       | `BROADCAST_INTENT`      |
| `transaction_hash` | **null**                |
| `nonce`            | reserved treasury nonce |

means dispatch committed a durable pre-broadcast intent, then the process died
(or otherwise failed) before a hash was recorded. A transfer **may or may not**
have been broadcast at that nonce — ambiguous by design.

**This is fail-closed, not a bug.** The per-wallet gate stays closed
(`PENDING_FUNDING_EXISTS`) so a waiter cannot broadcast a second top-up
(AGENTS.md §7.5 / C4 / C7 TX.10 amendment).

**How it clears:** the wallet reconciler settles the row once the treasury's
**confirmed** account nonce advances past the reserved one (TX.9 bisects the
nonce hunt). Outcomes:

- Matching outgoing transfer found → promote to `submitted` and track the receipt.
- A different transaction consumed the slot → mark `replaced`.

**Idle-treasury wedge:** if nothing else spends from that treasury, the account
nonce may never advance on its own, so the gate can persist across reconciler
runs. Identify these rows:

```sql
SELECT id, operation_id, treasury_id, managed_wallet_id, amount_wei,
       nonce, status, error_code, created_at
FROM funding_transactions
WHERE status = 'submission_unknown'
  AND error_code = 'BROADCAST_INTENT'
  AND transaction_hash IS NULL
ORDER BY created_at ASC;
```

Evidence that would justify further action (still not a hand clear of the gate):

- Explorer / RPC shows a native transfer at the reserved nonce to the managed
  wallet for the recorded amount → wait for or trigger reconciliation to promote.
- Confirmed treasury nonce has advanced and a _different_ tx occupied the slot →
  reconciliation should mark replaced; if it has not, escalate with that evidence.
- Confirmed treasury nonce still equals the reserved nonce after a long idle
  period → the send likely never left the process; the wedge remains until
  another legitimate treasury transaction advances the nonce, or engineering
  reviews with on-chain proof.

**Never** `UPDATE` / `DELETE` the row to clear `PENDING_FUNDING_EXISTS` without
positive on-chain evidence. Absence of a visible transaction is **not** proof one
was not broadcast (mempool, indexer lag, wrong explorer view). Clearing by hand
reopens the duplicate-transfer class TX.10 closed.

## Steps

1. Locate the stuck row:

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-transactions?managedWalletId=<wallet-uuid>&limit=20" | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-transactions?status=submission_unknown&limit=50" | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-operations/<operation-uuid>" | jq
```

Or SQL (read-only):

```sql
SELECT id, operation_id, treasury_id, managed_wallet_id, amount_wei,
       transaction_hash, nonce, status, error_code, created_at, submitted_at
FROM funding_transactions
WHERE status IN ('created', 'submitted', 'submission_unknown')
ORDER BY created_at ASC;
```

2. Branch on status:

### A. `submitted` (hash present)

1. Open `transaction.explorerUrl` / `transactionHash` on Sepolia.
2. Re-poll the operation (resumes tracking):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/funding-operations/<operation-uuid>" | jq
```

3. Outcomes you may see: view status `succeeded` / `reverted` / `replaced` /
   `dropped` / still `pending` (including confirmation timeout — timeout is
   **not** failure per D4).
4. If the explorer shows confirmed but the API still pending, wait for
   confirmations (`FUNDING_CONFIRMATIONS`, default `1`) and retry GET. If logs
   show RPC errors, fix `CHAIN_RPC_URL` first.

### B. `submission_unknown` (no hash)

Reconciliation settles these on positive evidence (confirmed nonce past the
reserved slot → promote or mark replaced). Prefer waiting for the next
`chainbank-wallet-reconciler` run over hand edits.

If `error_code = 'BROADCAST_INTENT'`, see
[`BROADCAST_INTENT` (TX.10 residual wedge)](#broadcast_intent-tx10-residual-wedge)
first.

1. Note `nonce`, `treasury_id`, `amount_wei`, `managed_wallet_id`, `error_code`.
2. Resolve treasury address:

```sql
SELECT id, address, address_display, enabled
FROM treasuries
WHERE id = '<treasury-uuid>';
```

3. On the explorer / RPC, inspect that treasury account:
   - Current transaction count (nonce).
   - Whether a native transfer of the expected value to the managed wallet
     exists at the recorded nonce.
4. Interpret:
   - **Tx found and confirmed:** funds likely moved; leave the row for
     reconciliation to promote. Do **not** `UPDATE` the row to `failed` or
     `confirmed` ad hoc — wrong terminal state reopens the gate or hides
     ambiguity (`tasks/SECURITY-REVIEW-T1.5.md`).
   - **Nonce not yet advanced; no tx visible:** may still be in mempool, or an
     idle-treasury `BROADCAST_INTENT` wedge — wait; keep funding kill-switched
     for that wallet’s project if risk is high.
   - **Nonce advanced with a different tx:** reconciliation should mark
     `replaced`; escalate with explorer evidence if the row stays in-flight.
5. If in-flight accounting is blocking _other_ wallets’ reserve, either wait for
   reconciliation or keep
   [`disable-all-automated-funding.md`](./disable-all-automated-funding.md)
   engaged while you escalate — do not delete the row.

### C. `created` (no hash, pre-submit / interrupted path)

Rare in steady state. Confirm whether a broadcast could have occurred (same
nonce investigation as B). Prefer kill switch + engineer review over guessing a
terminal status in SQL.

3. When the row reaches a real terminal status through the app
   (`confirmed` / `reverted` / `replaced` / `dropped` / pre-broadcast `failed`),
   retry ensure-funded with a **new** idempotency key only if policy still
   requires a top-up.

## Verification

- `GET /v1/funding-transactions?managedWalletId=…` shows no in-flight statuses
  for that wallet before you expect a new top-up to succeed.
- A deliberate ensure-funded no longer returns `PENDING_FUNDING_EXISTS` for that
  wallet (unless another in-flight row appeared).
- For `submission_unknown`, prefer a reconciler-driven status change over a
  hand SQL write. Until then, verification is on-chain observation.

## Rollback / if this goes wrong

- Never `DELETE FROM funding_transactions` / `funding_operations`.
- Never force `status = 'failed'` on `submission_unknown` to clear
  `PENDING_FUNDING_EXISTS` — that was the defect class fixed in T1.5 / TX.10.
- If you must stop all risk while stuck: kill switch
  ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).

## Not yet automated (state plainly)

| Capability                                                       | Status                                    |
| ---------------------------------------------------------------- | ----------------------------------------- |
| Settle `submission_unknown` by nonce (promote / replaced)        | Deployed (T4.1 / TX.9 reconciler)         |
| Clear idle-treasury `BROADCAST_INTENT` without nonce advancement | Does not exist (fail closed; see section) |
| Operator endpoint/script to mark in-flight rows terminal         | Does not exist                            |
| Persist hash before broadcast (sign-then-send-raw)               | Follow-up in security review              |
