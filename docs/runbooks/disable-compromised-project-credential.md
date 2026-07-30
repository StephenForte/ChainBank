# Disable compromised project credential

**Use this when:** a project-service (or any) API token may be leaked, abused, or
observed in logs/tickets, and it must stop authenticating **immediately**.

**Do not use this for:** a calm, planned token rotation with no suspected leak —
use [`rotate-service-token.md`](./rotate-service-token.md). If the treasury key
is the compromised secret — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md) and consider
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Preconditions

- DBA / operator access to the hosted Postgres (Render External Database URL or
  Shell + `psql`).
- **There is no revoke API, npm script, or repository method** that sets
  `enabled` / `revoked_at` (Known gaps in [`README.md`](./README.md)). This
  runbook **is** the SQL workaround.
- Optional: ability to issue a replacement later via `npm run credential:issue`.

## Steps

1. Identify the credential — **SELECT first**. Prefer `token_prefix` (first 11
   characters of the `cb_…` token — non-secret) or known `name` / `id`:

```sql
SELECT id, name, role, enabled, revoked_at, token_prefix, last_used_at, created_at
FROM api_credentials
WHERE role = 'project-service'
ORDER BY created_at DESC;

-- Or narrow:
SELECT id, name, role, enabled, revoked_at, token_prefix, last_used_at
FROM api_credentials
WHERE token_prefix = 'cb_………'
   OR name = '<credential-name>'
   OR id = '<credential-uuid>';
```

2. Disable it (sets both gates honored by `authenticate-credential`):

```sql
UPDATE api_credentials
SET enabled = false,
    revoked_at = now(),
    updated_at = now()
WHERE id = '<credential-uuid>'
  AND (enabled = true OR revoked_at IS NULL);
```

3. Confirm:

```sql
SELECT id, name, role, enabled, revoked_at, token_prefix
FROM api_credentials
WHERE id = '<credential-uuid>';
-- Expect enabled = false AND revoked_at IS NOT NULL
```

4. Prove auth fails (HTTP 401). Internal code is `CREDENTIAL_DISABLED`; public
   message matches invalid credentials (`The supplied credential is not valid.`):

```bash
export BASE='https://chainbank-web.onrender.com'
curl -s -H "Authorization: Bearer $COMPROMISED_TOKEN" \
  "$BASE/v1/wallets" | jq
```

5. Optionally disable the project or environment to stop other scoped tokens and
   funding until review (these **do** have APIs):

```bash
export TOKEN='cb_…'   # operator

curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/projects/<project-uuid>" | jq

curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/v1/environments/<environment-uuid>" | jq
```

Disabled entities refuse funding with `ENTITY_DISABLED`.

6. SQL disable does **not** append `audit_events`. Record who/when/why in your
   incident log. Issue a replacement only after the leak is contained
   ([`rotate-service-token.md`](./rotate-service-token.md)).

## Verification

- Compromised token → 401 on any `/v1/*` authenticated route.
- Row shows `enabled = false`, `revoked_at` set.
- If you disabled the project/environment, ensure-funded for its wallets returns
  `ENTITY_DISABLED` even with a valid operator token when those flags are off.

## Rollback / if this goes wrong

- Wrong credential disabled: only re-enable if you still trust the token:

```sql
SELECT id, name, enabled, revoked_at FROM api_credentials WHERE id = '<uuid>';

UPDATE api_credentials
SET enabled = true,
    revoked_at = NULL,
    updated_at = now()
WHERE id = '<uuid>';
```

- Prefer issuing a **new** credential over re-enabling one that may have been
  exposed.
