# Rotate Public (external) treasury key

**Use this when:** the Public (external) hot-wallet signing key must be replaced
(suspected compromise, scheduled rotation, or moving to a new EOA). For an EOA, a
new key implies a **new address** — update `TREASURY_PRIVATE_KEY` and
`TREASURY_ADDRESS` together. Do **not** change `TREASURY_OPERATIONAL_*` here;
for the Private (operational) treasury, use
[`rotate-operational-treasury-key.md`](./rotate-operational-treasury-key.md).

**Do not use this for:** rotating an API bearer token — use
[`rotate-service-token.md`](./rotate-service-token.md). For only changing
warning/critical/recovery/reserve numbers — use
[`change-thresholds-safely.md`](./change-thresholds-safely.md).

## Preconditions

- Two operators recommended: one holds the new key material, one performs Render
  env changes (four-eyes on the secret).
- Access to Render Environment for **`chainbank-web`** and
  **`chainbank-wallet-reconciler`** for `TREASURY_PRIVATE_KEY`. Both services are
  signing-capable (`isSigningCapableRole`: `web` and `cron-reconciler`; see D12).
  The **`chainbank-treasury-monitor` must never receive that key** (monitor strips
  signing keys before parse).
- Both signing services and the monitor need the matching `TREASURY_ADDRESS`.
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
2. **Ambiguity guard (C23).** While more than one enabled **external** treasury
   exists for the same chain, funding refuses with `INVALID_CONFIGURATION` before
   any signer call. Two-tier deployments may still have one enabled external and
   one enabled operational row on the same chain — ambiguity is **per kind**, not
   per chain. That turns an address-only config change into a loud refusal instead
   of a silent spend from the old row.
3. **`assertSignerMatchesTreasury`** additionally refuses to sign unless the
   signer address (derived from `TREASURY_PRIVATE_KEY`) matches the _resolved_
   external treasury row. After the retired row is disabled, funding resolves the
   remaining external row and the signer must match that address.
4. **Disable the retired row via the API** — never SQL in the happy path:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/treasuries/<retired-treasury-uuid>"
```

## Steps

1. **Stop signing** — set `FUNDING_KILL_SWITCH=true` on **`chainbank-web`** and
   **`chainbank-wallet-reconciler`**, then redeploy/restart each so the running
   process reloads config (see
   [`disable-all-automated-funding.md`](./disable-all-automated-funding.md)).
   Until those restarts finish, the old processes can still sign.

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

3. Fund the **new** Public address with Sepolia ETH (see
   [`replenish-treasury.md`](./replenish-treasury.md) pattern) before cutover if
   you expect immediate funding after re-enable.

4. Identify the current (soon-to-be-retired) **external** treasury id:

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
# Note the id whose address matches the current TREASURY_ADDRESS (kind external).
export RETIRED_TREASURY_ID='…'
```

5. In Render → **`chainbank-web`** → **Environment**:

   - Set `TREASURY_ADDRESS` to the **new** checksummed or lowercase address.
   - Set `TREASURY_PRIVATE_KEY` to the new `0x`-prefixed key (64 hex digits).
   - Leave threshold env vars unchanged unless you intend a threshold change
     ([`change-thresholds-safely.md`](./change-thresholds-safely.md)).
   - Leave `TREASURY_OPERATIONAL_*` unchanged.

6. In Render → **`chainbank-wallet-reconciler`** → **Environment**:

   - Set `TREASURY_ADDRESS` to the **same** new address.
   - Set `TREASURY_PRIVATE_KEY` to the **same** new key.
   - Leave `TREASURY_OPERATIONAL_*` unchanged.

7. In Render → **`chainbank-treasury-monitor`** → **Environment**:

   - Set `TREASURY_ADDRESS` to the **same** new address.
   - Confirm **`TREASURY_PRIVATE_KEY` is absent**.

8. Redeploy **web**, **wallet-reconciler**, and **treasury-monitor** (Manual
   Deploy). Web pre-deploy runs `npm run db:migrate:built`; boot runs
   `registerConfiguredTreasury`, which inserts the new address row (or updates
   thresholds if that address already existed).

9. **Expect funding to refuse** until the retired external row is disabled. With
   two enabled **external** rows for the chain, ensure-funded returns
   `INVALID_CONFIGURATION` with the public message that treasury configuration is
   ambiguous — that is the intended intermediate state, not a bug. One enabled
   external plus one enabled operational row is normal in two-tier mode.

10. **Disable the retired external treasury row** (soft-disable only; do not
    delete):

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/treasuries/$RETIRED_TREASURY_ID" | jq
# Expect data.enabled == false and an audit row treasury.disabled.
```

11. Confirm only the new Public address is listed among enabled external rows:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
# Expect the new external address; disabled rows are omitted (listEnabled).
# An enabled operational row may still appear — that is expected in two-tier mode.
```

12. Only after verification, clear the kill switch / re-enable funding per your
    change window (`FUNDING_KILL_SWITCH=false`, and `FUNDING_ENABLED=true` only
    when runbooks and policy allow). Redeploy **web** and **wallet-reconciler**
    again so each process picks up the env change.

## Verification

- `GET /v1/treasuries` lists the new Public address among enabled rows; the old
  external address is absent (disabled rows are not listed — `listEnabled`).
- Monitor logs: `Treasury observation recorded` for the new `treasuryId` after a
  Trigger Run.
- With two enabled **external** rows (before step 10), ensure-funded must return
  `INVALID_CONFIGURATION` with the ambiguous-configuration public message — never
  a successful submit from the old treasury.
- After re-enable: a real ensure-funded against a below-minimum wallet either
  funds or returns an expected gate (`FUNDING_BLOCKED_RESERVE`, etc.), not
  `INVALID_CONFIGURATION`.

## Rollback / if this goes wrong

- **Key updated, address not:** expect `INVALID_CONFIGURATION` on ensure-funded
  (signer/treasury mismatch). Set `TREASURY_ADDRESS` to the address of the key
  you deployed, redeploy web + wallet-reconciler + monitor, then disable any stale
  enabled external row via `PATCH /v1/treasuries/:id`.
- **Both env vars updated, old external row still enabled:** ambiguity guard
  refuses funding. Complete step 10.
- **Need to revert to the old wallet:** set env back to the old address + old key
  (from your secret store), redeploy web + wallet-reconciler + monitor, then
  `PATCH` the old id with `{"enabled":true}` and the abandoned new id with
  `{"enabled":false}`. Prefer kill switch during the revert.
- Open alerts on the old `entity_id` do not automatically move to the new row;
  treat alert state on the abandoned treasury as historical.
