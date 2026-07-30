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
- Operator or DBA access for the SQL disable step — **there is no revoke script
  or API** (Known gaps in [`README.md`](./README.md)).
- `api_credentials.name` is unique: the replacement credential needs a **new
  name** (or you must rename the old row in SQL before reusing a name).

## Steps

1. Identify the credential to retire — **SELECT first**:

```sql
SELECT id, name, role, enabled, revoked_at, token_prefix, last_used_at, created_at
FROM api_credentials
WHERE name = '<credential-name>'
   OR token_prefix = 'cb_………';  -- first 11 chars of the token, non-secret
```

Confirm `enabled = true` and `revoked_at IS NULL`.

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
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'   # new token

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/treasuries" | jq
```

4. **Manual workaround — disable the old credential** (no product tool):

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

`authenticate-credential` rejects when `enabled` is false **or** `revoked_at` is
set (`CREDENTIAL_DISABLED` internally; clients see the same public message as an
invalid credential: `The supplied credential is not valid.`).

5. This SQL path does **not** write an `audit_events` row. Record the rotation in
   your incident / change log.

## Verification

- New token: authenticated calls succeed (e.g. `GET /v1/treasuries` for operator /
  read-only).
- Old token:

```bash
curl -s -H "Authorization: Bearer $OLD_TOKEN" "$BASE/v1/treasuries" | jq
# Expect HTTP 401, error.code INVALID_CREDENTIAL or CREDENTIAL_DISABLED
# (public message: "The supplied credential is not valid.")
```

- SQL confirms `enabled = false` and `revoked_at` set on the old row.

## Rollback / if this goes wrong

- New token lost before clients updated: issue another credential (new name);
  leave the old one enabled until cutover succeeds, then disable both abandoned
  extras.
- Disabled the wrong row: `UPDATE api_credentials SET enabled = true, revoked_at = NULL, updated_at = now() WHERE id = '…'` after SELECT confirmation — only if you still trust that token.
- `credential:issue` fails on unique `name`: choose a new `--name` or rename the
  existing row in SQL first.
