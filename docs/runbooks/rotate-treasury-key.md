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
- An operator API token with permission to call
  `PATCH /v1/treasuries/:id` (operator role only).
- Funding should be off or kill-switched during the cutover:
  [`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Critical behavior (read before changing env)

1. **Bootstrap upsert conflict target is `(chain_id, address)`.** Changing
   `TREASURY_ADDRESS` inserts a **new** `treasuries` row. The old row keeps its
   history, observed balances, and alert entity id. Thresholds on the _matching_
   address row re-upsert from env on every boot
   (`registerConfiguredTreasury` + `onConflictDoUpdate`).
2. **Ambiguity guard (TX.5).** While more than one enabled treasury exists for
   the same chain, `ensure-funded` refuses with `INVALID_CONFIGURATION` before
   any signer call. That turns an address-only config change into a loud refusal
   instead of a silent spend from the old row.
3. **`assertSignerMatchesTreasury`** additionally refuses to sign unless the
   signer address (derived from `TREASURY_PRIVATE_KEY`) matches the _resolved_
   treasury row. After the retired row is disabled, funding resolves the remaining
   row and the signer must match that address.
4. **Disable the retired row via the API** — never SQL in the happy path:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/treasuries/<retired-treasury-uuid>"
```

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

4. Identify the current (soon-to-be-retired) treasury id:

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
# Note the id whose address matches the current TREASURY_ADDRESS.
export RETIRED_TREASURY_ID='…'
```

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

8. **Expect funding to refuse** until the retired row is disabled. With two
   enabled rows for the chain, `ensure-funded` returns `INVALID_CONFIGURATION`
   with the public message that treasury configuration is ambiguous — that is
   the intended intermediate state, not a bug.

9. **Disable the retired treasury row** (soft-disable only; do not delete):

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/treasuries/$RETIRED_TREASURY_ID" | jq
# Expect data.enabled == false and an audit row treasury.disabled.
```

10. Confirm only the new address is listed:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
# Expect the new address only (listEnabled omits disabled rows).
```

11. Only after verification, clear the kill switch / re-enable funding per your
    change window (`FUNDING_KILL_SWITCH=false`, and `FUNDING_ENABLED=true` only
    when runbooks and policy allow). Redeploy web again so the process picks up
    the env change.

## Verification

- `GET /v1/treasuries` lists the new address; old address absent (disabled rows
  are not listed — `listEnabled`).
- Monitor logs: `Treasury observation recorded` for the new `treasuryId` after a
  Trigger Run.
- With two enabled rows (before step 9), ensure-funded must return
  `INVALID_CONFIGURATION` with the ambiguous-configuration public message — never
  a successful submit from the old treasury.
- After re-enable: a real ensure-funded against a below-minimum wallet either
  funds or returns an expected gate (`FUNDING_BLOCKED_RESERVE`, etc.), not
  `INVALID_CONFIGURATION`.

## Rollback / if this goes wrong

- **Key updated, address not:** expect `INVALID_CONFIGURATION` on ensure-funded
  (signer/treasury mismatch). Set `TREASURY_ADDRESS` to the address of the key
  you deployed, redeploy web + cron, then disable any stale enabled row via
  `PATCH /v1/treasuries/:id`.
- **Both env vars updated, old row still enabled:** ambiguity guard refuses
  funding. Complete step 9.
- **Need to revert to the old wallet:** set env back to the old address + old key
  (from your secret store), redeploy, then
  `PATCH` the old id with `{"enabled":true}` and the abandoned new id with
  `{"enabled":false}`. Prefer kill switch during the revert.
- Open alerts on the old `entity_id` do not automatically move to the new row;
  treat alert state on the abandoned treasury as historical.
