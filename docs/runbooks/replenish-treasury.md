# Replenish treasury

**Use this when:** the Sepolia hot-wallet treasury balance is at or below warning /
critical thresholds (email alert, dashboard status, or `GET /v1/treasuries`), and
you need to add ETH so funding and alerts can recover.

**Do not use this for:** rotating the signing key or changing `TREASURY_ADDRESS`
— use [`rotate-treasury-key.md`](./rotate-treasury-key.md). For emergency stop of
signing while you refill, use
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Preconditions

- Operator with access to a funded Sepolia source wallet (not ChainBank — humans
  replenish; the service never claims faucets).
- Operator API credential (`role = operator`) for the hosted instance.
- Render (or local) knowledge of the live `TREASURY_ADDRESS` env var on
  `chainbank-web` / `chainbank-treasury-monitor`.
- Confirm you are sending **Sepolia** ETH (`CHAIN_ID=11155111`), not mainnet.

## Steps

1. Confirm the treasury address ChainBank is watching:

```bash
export BASE='https://chainbank-web.onrender.com'   # your URL
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
```

Note `data[].id`, `data[].address`, and `data[].balance` / `data[].status`.

2. In Render → `chainbank-web` → **Environment**, confirm `TREASURY_ADDRESS`
   matches the address returned above. If they differ, stop and follow
   [`rotate-treasury-key.md`](./rotate-treasury-key.md) (orphan treasury rows).

3. From your external wallet, send Sepolia ETH to that exact treasury address.
   Amount guidance: bring the balance **above** `TREASURY_RECOVERY_BALANCE_ETH`
   so an open alert can resolve, and keep enough headroom above
   `TREASURY_MINIMUM_RESERVE_ETH` for gas + top-ups.

4. Wait for the transfer to confirm on Sepolia (explorer for the treasury
   address).

5. Trigger a read-only observation (does not move funds):

```bash
export TREASURY_ID='…from list…'

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' \
  "$BASE/v1/treasuries/$TREASURY_ID/check" | jq
```

Expected: `check.outcome` is `"observed"`, and `data.balance` reflects the new
on-chain amount. Open alerts evaluate on this path and on the next
treasury-monitor cron run.

6. Optional: Render → `chainbank-treasury-monitor` → **Trigger Run** so the daily
   job also records the observation and sends a recovery email if thresholds
   warrant it. Confirm exit 0 and log line `Treasury observation recorded`.

## Verification

- `POST /v1/treasuries/:id/check` → `check.outcome: "observed"`.
- `GET /v1/treasuries` shows an updated balance and non-`unknown` status when RPC
  is healthy.
- If a warning/critical alert was open, after recovery threshold is met you should
  see a recovery email (cron or check path) and `alerts.state = 'resolved'` for
  that treasury entity — do not delete alert rows.

## Rollback / if this goes wrong

- Sent to the wrong address: ChainBank cannot recover those funds. Correct
  `TREASURY_ADDRESS` only via [`rotate-treasury-key.md`](./rotate-treasury-key.md)
  if the watched address itself must change.
- Check returns `outcome: "unavailable"` / `RPC_UNAVAILABLE`: the refill may still
  be on-chain; retry later. RPC failure must not be treated as zero balance.
- Balance still below reserve after refill: top up further before expecting
  `ensure-funded` to succeed (`FUNDING_BLOCKED_RESERVE`).
