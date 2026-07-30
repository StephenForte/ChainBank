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
- Understanding that **resolving `submission_unknown` is not automated** —
  deferred to Phase 4 reconciliation (`tasks/SECURITY-REVIEW-T1.5.md` follow-ups;
  worker-plan T4.1). There is no npm script or endpoint that searches by nonce
  and closes the row.

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

### B. `submission_unknown` (no hash — Phase 4 gap)

**Manual observation only — no supported write path to “fix” the row today.**

1. Note `nonce`, `treasury_id`, `amount_wei`, `managed_wallet_id`.
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
   - **Tx found and confirmed:** funds likely moved; the DB row still blocks
     duplicates and still counts as in-flight until Phase 4 reconciliation.
     Do **not** `UPDATE` the row to `failed` or `confirmed` ad hoc — wrong
     terminal state reopens the gate or hides ambiguity
     (`tasks/SECURITY-REVIEW-T1.5.md`).
   - **Nonce not yet advanced; no tx visible:** may still be in mempool — wait;
     keep funding kill-switched for that wallet’s project if risk is high.
   - **Nonce advanced with a different tx:** treat as replaced on-chain; still
     no automated DB transition for `submission_unknown` today.
5. If in-flight accounting is blocking _other_ wallets’ reserve, either wait for
   Phase 4 tooling or keep
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
- For `submission_unknown`, verification today is **on-chain observation +
  documented escalation**, not a green API status change.

## Rollback / if this goes wrong

- Never `DELETE FROM funding_transactions` / `funding_operations`.
- Never force `status = 'failed'` on `submission_unknown` to clear
  `PENDING_FUNDING_EXISTS` — that was the defect class fixed in T1.5.
- If you must stop all risk while stuck: kill switch
  ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).

## Not yet automated (state plainly)

| Capability                                                           | Status                       |
| -------------------------------------------------------------------- | ---------------------------- |
| Search treasury txs by recorded nonce and close `submission_unknown` | Phase 4 (T4.1)               |
| Operator endpoint/script to mark in-flight rows terminal             | Does not exist               |
| Persist hash before broadcast (sign-then-send-raw)                   | Follow-up in security review |
