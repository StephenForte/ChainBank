# Rotate treasury key

**Use this when:** the hot-wallet signing key must be replaced (suspected
compromise, scheduled rotation, or moving to a new EOA). For an EOA, a new key
implies a **new address** — update `TREASURY_PRIVATE_KEY` and `TREASURY_ADDRESS`
together.

**Do not use this for:** rotating an API bearer token — use
[`rotate-service-token.md`](./rotate-service-token.md). For only changing
warning/critical/recovery/reserve numbers — use
[`change-thresholds-safely.md`](./change-thresholds-safely.md).

## Preconditions

- Two operators recommended: one holds the new key material, one performs Render
  env changes (four-eyes on the secret).
- Access to Render Environment for **`chainbank-web` only** for
  `TREASURY_PRIVATE_KEY`. The **`chainbank-treasury-monitor` must never receive
  that key** (`isSigningCapableRole` is `web` only; monitor strips it before
  parse).
- Both services need the matching `TREASURY_ADDRESS`.
- Operator DB access (Render External Database URL or web Shell + `psql`) — there
  is **no API** to disable a treasury row (see Known gaps in
  [`README.md`](./README.md)).
- Funding should be off or kill-switched during the cutover:
  [`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Critical behavior (read before changing env)

1. **Bootstrap upsert conflict target is `(chain_id, address)`.** Changing
   `TREASURY_ADDRESS` inserts a **new** `treasuries` row. The old row keeps its
   history, observed balances, and alert entity id. Thresholds on the _matching_
   address row re-upsert from env on every boot
   (`registerConfiguredTreasury` + `onConflictDoUpdate`).
2. **Funding resolves the oldest enabled treasury on the chain**
   (`listEnabled()` ordered by `created_at` ASC, then first matching `chainId`).
   If the old row stays `enabled = true`, ensure-funded still binds reserve and
   nonce accounting to the **old** address.
3. **`assertSignerMatchesTreasury`** refuses to sign unless the signer address
   (derived from `TREASURY_PRIVATE_KEY`) matches the resolved treasury row
   address. A rotation that updates the key but not `TREASURY_ADDRESS`, or that
   leaves the old row enabled so funding still resolves to the old address, fails
   closed with:

   - code: `INVALID_CONFIGURATION` (HTTP 400)
   - public message: `Funding is unavailable because the treasury signer is misconfigured.`
   - internal log: `Treasury signing key does not match the configured treasury address; refusing to sign.`

## Steps

1. **Stop signing** — set `FUNDING_KILL_SWITCH=true` on `chainbank-web` and
   redeploy/restart so the running process reloads config (see
   [`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).
   Until that restart finishes, the old process can still sign.

2. Generate or import the new disposable Sepolia hot-wallet key **offline**.
   Derive its address. Never commit the key; never paste it into tickets.

   To generate one locally using viem (already a dependency — nothing is
   installed and nothing leaves the machine):

```bash
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('address:',privateKeyToAccount(k).address);console.log('private key:',k)"
```

To use a key that already exists, export it from the wallet that holds it —
in MetaMask, account menu → **Account details** → **Show private key**. A
hardware wallet cannot export, by design; use a separate hot wallet instead.

Either way, **verify the derived address matches the `TREASURY_ADDRESS` you
intend to set** before going further. `assertSignerMatchesTreasury` refuses to
sign on a mismatch, so an error here fails closed — but it costs a deploy
cycle to discover.

Copy the key straight into the Render environment field. Do not route it
through a scratch file, a shared note, or a shell history.

3. Fund the **new** address with Sepolia ETH (see
   [`replenish-treasury.md`](./replenish-treasury.md) pattern) before cutover if
   you expect immediate funding after re-enable.

4. Identify the current treasury row(s) — **SELECT first**:

```sql
SELECT id, address, address_display, enabled, created_at, status,
       last_observed_balance_wei, minimum_reserve_wei
FROM treasuries
ORDER BY created_at ASC;
```

Note the `id` of the row whose `address` matches the **current** (soon-to-be-old)
`TREASURY_ADDRESS`.

5. In Render → `chainbank-web` → **Environment**:

   - Set `TREASURY_ADDRESS` to the **new** checksummed or lowercase address.
   - Set `TREASURY_PRIVATE_KEY` to the new `0x`-prefixed key (64 hex digits).
   - Leave threshold env vars unchanged unless you intend a threshold change
     ([`change-thresholds-safely.md`](./change-thresholds-safely.md)).

6. In Render → `chainbank-treasury-monitor` → **Environment**:

   - Set `TREASURY_ADDRESS` to the **same** new address.
   - Confirm **`TREASURY_PRIVATE_KEY` is absent**.

7. Redeploy **web** and **cron** (Manual Deploy). Web pre-deploy runs
   `npm run db:migrate:built`; boot runs `registerConfiguredTreasury`, which
   inserts the new address row (or updates thresholds if that address already
   existed).

8. **Manual workaround — disable the old treasury row** (no product tool exists):

```sql
-- Confirm target again
SELECT id, address, enabled FROM treasuries WHERE id = '<old-treasury-uuid>';

-- Soft-disable only; do not DELETE (history / alerts stay)
UPDATE treasuries
SET enabled = false,
    updated_at = now()
WHERE id = '<old-treasury-uuid>'
  AND enabled = true;
```

9. Confirm only the new address is enabled:

```sql
SELECT id, address, enabled, created_at FROM treasuries ORDER BY created_at ASC;
```

10. Smoke (operator token):

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
# Expect the new address only among enabled rows returned by the API.
```

11. Only after verification, clear the kill switch / re-enable funding per your
    change window (`FUNDING_KILL_SWITCH=false`, and `FUNDING_ENABLED=true` only
    when runbooks and policy allow). Redeploy web again so the process picks up
    the env change.

## Verification

- `GET /v1/treasuries` lists the new address; old address absent (disabled rows are
  not listed — `listEnabled`).
- Monitor logs: `Treasury observation recorded` for the new `treasuryId` after a
  Trigger Run.
- A deliberate ensure-funded with mismatched key/address (if tested in a non-prod
  clone) must return `INVALID_CONFIGURATION` with the public misconfiguration
  message — never a successful submit.
- After re-enable: a real ensure-funded against a below-minimum wallet either
  funds or returns an expected gate (`FUNDING_BLOCKED_RESERVE`, etc.), not
  `INVALID_CONFIGURATION`.

## Rollback / if this goes wrong

- **Key updated, address not:** expect `INVALID_CONFIGURATION` on ensure-funded.
  Set `TREASURY_ADDRESS` to the address of the key you deployed, redeploy web +
  cron, then disable any stale enabled row.
- **Both env vars updated, old row still enabled:** funding still resolves to the
  oldest enabled row → same `INVALID_CONFIGURATION`. Complete step 8.
- **Need to revert to the old wallet:** set env back to the old address + old key
  (from your secret store), redeploy, `UPDATE treasuries SET enabled = true`
  for the old id and `enabled = false` for the abandoned new id. Prefer kill
  switch during the revert.
- Open alerts on the old `entity_id` do not automatically move to the new row;
  treat alert state on the abandoned treasury as historical.
