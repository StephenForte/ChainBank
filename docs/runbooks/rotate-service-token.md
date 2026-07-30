# Rotate service token

**Use this when:** you are replacing an API bearer token on a planned schedule
(operator, project-service, or read-only), and the old token is not believed to
be under active attacker control.

**Do not use this for:** a suspected leak or abuse — use
[`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md)
**first** (disable immediately), then issue a replacement with this procedure.

## Preconditions

- Ability to run `npm run credential:issue` against the **same database** the
  hosted API uses (prefer laptop + Render External Database URL so the raw token
  never appears in hosted logs — same pattern as
  [`deploy-render-phase0.md`](./deploy-render-phase0.md)).
- An **operator** bearer token for the admin credential endpoints.
- `api_credentials.name` is unique: the replacement credential needs a **new
  name** (or you must rename the old row in SQL before reusing a name).

## Steps

1. Identify the credential to retire — list via the API (preferred):

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'   # operator token

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/admin/credentials?limit=100" | jq
```

Find the row by `name`, `tokenPrefix` (first 11 characters of the `cb_…` token —
non-secret), or `id`. Confirm `enabled = true` and `revokedAt` is null.

2. Issue a replacement (example: operator). Adjust `--role` and optional
   `--scope` for project-service credentials:

```bash
export DATABASE_URL='postgres://…external-render-url…'
export CHAIN_ID=11155111
export CHAIN_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
export TREASURY_ADDRESS='0xYourHotWallet'
export TREASURY_WARNING_BALANCE_ETH=1
export TREASURY_CRITICAL_BALANCE_ETH=0.25
export TREASURY_RECOVERY_BALANCE_ETH=2
export TREASURY_MINIMUM_RESERVE_ETH=0.5
export CHAINBANK_ENVIRONMENT=local

npm run credential:issue -- \
  --name "operator-render-2026-07-30" \
  --role operator
```

For a scoped project-service token:

```bash
npm run credential:issue -- \
  --name "project-acme-2026-07-30" \
  --role project-service \
  --scope '<project-uuid>' \
  --scope '<project-uuid>:<environment-uuid>'
```

Store the printed `cb_…` token in a password manager. It is shown once; only the
SHA-256 hash is stored.

3. Update every client / secret store that used the old token to the new token.
   Confirm a smoke call with the **new** token:

```bash
curl -s -H "Authorization: Bearer $NEW_TOKEN" "$BASE/v1/treasuries" | jq
```

4. **Revoke the old credential** (terminal — sets `enabled = false` and
   `revoked_at`, and writes an audit event):

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"revoke"}' \
  "$BASE/v1/admin/credentials/<old-credential-uuid>" | jq
```

For a planned rotation where you may need to re-enable via SQL if cutover fails,
use `"action":"disable"` instead (sets `enabled = false` only; `revoked_at` stays
null). Revoke is preferred once the new token is confirmed everywhere.

`authenticate-credential` rejects when `enabled` is false **or** `revoked_at` is
set (`CREDENTIAL_DISABLED` internally; clients see the same public message as an
invalid credential: `The supplied credential is not valid.`).

You **cannot** disable or revoke the operator token you are currently using — the
API returns `CREDENTIAL_SELF_MUTATION_DENIED`. Use a second operator credential for
the mutation, or perform the SQL fallback below.

5. **If the API is unavailable** — SQL fallback (writes no audit event; record the
   change in your incident / change log):

```sql
SELECT id, name, role, enabled, revoked_at, token_prefix
FROM api_credentials
WHERE id = '<old-credential-uuid>';

UPDATE api_credentials
SET enabled = false,
    revoked_at = now(),
    updated_at = now()
WHERE id = '<old-credential-uuid>'
  AND revoked_at IS NULL;
```

## Verification

- New token: authenticated calls succeed (e.g. `GET /v1/treasuries` for operator /
  read-only).
- Old token:

```bash
curl -s -H "Authorization: Bearer $OLD_TOKEN" "$BASE/v1/treasuries" | jq
# Expect HTTP 401, error.code INVALID_CREDENTIAL or CREDENTIAL_DISABLED
# (public message: "The supplied credential is not valid.")
```

- `GET /v1/admin/credentials` shows `enabled = false` and `revokedAt` set on the
  old row (or `revokedAt` null if you used `disable` only).
- An `audit_events` row with action `credential.revoked` or `credential.disabled`
  exists when you used the API path.

## Rollback / if this goes wrong

- New token lost before clients updated: issue another credential (new name);
  leave the old one enabled until cutover succeeds, then disable both abandoned
  extras.
- Disabled the wrong row via API: only re-enable if you still trust that token,
  using the SQL fallback in
  [`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md).
- `credential:issue` fails on unique `name`: choose a new `--name` or rename the
  existing row in SQL first.
