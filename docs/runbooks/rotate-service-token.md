# Rotate service token

**Use this when:** you are replacing an API bearer token on a planned schedule
(operator, project-service, or read-only), and the old token is not believed to
be under active attacker control.

**Do not use this for:** a suspected leak or abuse — use
[`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md)
**first** (disable immediately), then issue a replacement with this procedure.

## Preconditions

- Ability to run `npm run credential:issue` against the **same database** the
  hosted API uses. Credentials live in whichever Postgres issued them, so a token
  issued against your local database will fail on the hosted API with
  `INVALID_CREDENTIAL` (that code means _no row matches the hash_ — a revoked or
  disabled credential returns `CREDENTIAL_DISABLED` instead). Two routes:
  - **Render web Shell on `chainbank-web` (simplest).** `DATABASE_URL`,
    `DATABASE_SSL_CA` and the rest are already set there, and `npm ci --include=dev`
    at build time leaves `tsx` on the filesystem, so `npm run credential:issue`
    works with no further setup. The raw token appears in that interactive shell
    session.
  - **Laptop + Render External Database URL** keeps the token off hosted machines,
    but the Blueprint sets `ipAllowList: []` on the database, so external
    connections are refused until you temporarily add your IP under the database's
    Access Control. Remove it afterwards. You also need `DATABASE_SSL=true` plus
    `DATABASE_SSL_CA` (escaped `\n` PEM is accepted) and the chain/treasury
    variables `loadConfig` requires.
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

For a planned rotation, use `"action":"disable"` first (sets `enabled = false`
only; `revoked_at` stays null) so a failed cutover can be undone with
`"action":"enable"` through the same endpoint. Revoke once the new token is
confirmed everywhere — revocation is terminal and `enable` will refuse it with
`CREDENTIAL_REVOKED`.

`authenticate-credential` rejects when `enabled` is false **or** `revoked_at` is
set (`CREDENTIAL_DISABLED` internally; clients see the same public message as an
invalid credential: `The supplied credential is not valid.`).

You **cannot** disable, revoke, or enable the operator token you are currently
using — the API returns `CREDENTIAL_SELF_MUTATION_DENIED`. **Keep a second
operator credential issued and stored ahead of time**; it is the intended path
for mutating an operator token, and the SQL fallback below is the last resort.

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
- Disabled the wrong row via API: re-enable it through the API if you still trust
  that token — `PATCH /v1/admin/credentials/<uuid>` with `{"action":"enable"}`.
  If it was **revoked** rather than disabled, that is terminal by design; issue a
  replacement instead.
- `credential:issue` fails on unique `name`: choose a new `--name` or rename the
  existing row in SQL first.
