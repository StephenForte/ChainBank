# Disable compromised project credential

**Use this when:** a project-service (or any) API token may be leaked, abused, or
observed in logs/tickets, and it must stop authenticating **immediately**.

**Do not use this for:** a calm, planned token rotation with no suspected leak —
use [`rotate-service-token.md`](./rotate-service-token.md). If the treasury key
is the compromised secret — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md) and consider
[`disable-all-automated-funding.md`](./disable-all-automated-funding.md).

## Preconditions

- An **operator** bearer token for the admin credential endpoints.
- Optional: ability to issue a replacement later via `npm run credential:issue`.

## Steps

1. Identify the credential — list via the API (preferred):

```bash
export BASE='https://chainbank-web.onrender.com'
export TOKEN='cb_…'   # operator token (not the compromised token)

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/admin/credentials?limit=100" | jq
```

Find the row by `tokenPrefix` (first 11 characters of the `cb_…` token — non-secret),
`name`, or `id`. For project-service credentials, filter the JSON by
`"role": "project-service"`.

2. **Revoke it immediately** (terminal — sets both gates honored by
   `authenticate-credential`, and writes an audit event):

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"revoke"}' \
  "$BASE/v1/admin/credentials/<credential-uuid>" | jq
```

Use `"action":"disable"` only when you need a reversible stop (no `revoked_at`);
for active compromise, always **revoke**.

You **cannot** disable, revoke, or enable the operator token you are currently
using (`CREDENTIAL_SELF_MUTATION_DENIED`). Authentication rejects disabled and
revoked credentials alike, so self-mutation would lock you out with no
in-product way back. **Keep a second operator credential issued and stored
before you need this runbook** — that is the intended recovery path, and the
SQL fallback below is the last resort if you have neither.

3. Confirm via the list endpoint:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/admin/credentials/<credential-uuid>"  # not supported — re-list and filter
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/admin/credentials?limit=100" | jq '.data[] | select(.id=="<credential-uuid>")'
# Expect enabled = false AND revokedAt set (for revoke)
```

4. Prove auth fails (HTTP 401). Internal code is `CREDENTIAL_DISABLED`; public
   message matches invalid credentials (`The supplied credential is not valid.`):

```bash
curl -s -H "Authorization: Bearer $COMPROMISED_TOKEN" \
  "$BASE/v1/wallets" | jq
```

5. Optionally disable the project or environment to stop other scoped tokens and
   funding until review (these **do** have APIs):

```bash
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

6. Issue a replacement only after the leak is contained
   ([`rotate-service-token.md`](./rotate-service-token.md)).

## If the API is unavailable — SQL fallback

Writes **no** audit event; record who/when/why in your incident log.

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

UPDATE api_credentials
SET enabled = false,
    revoked_at = now(),
    updated_at = now()
WHERE id = '<credential-uuid>'
  AND (enabled = true OR revoked_at IS NULL);

SELECT id, name, role, enabled, revoked_at, token_prefix
FROM api_credentials
WHERE id = '<credential-uuid>';
-- Expect enabled = false AND revoked_at IS NOT NULL
```

## Verification

- Compromised token → 401 on any `/v1/*` authenticated route.
- List or SQL confirms `enabled = false`, `revoked_at` set (for revoke).
- API path: `audit_events` contains `credential.revoked` with the acting operator
  credential id.
- Scope rows on `api_credential_scopes` are **not** deleted (forensic value).
- If you disabled the project/environment, ensure-funded for its wallets returns
  `ENTITY_DISABLED` even with a valid operator token when those flags are off.

## Rollback / if this goes wrong

- Wrong credential **disabled** (not revoked), and you still trust the token:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"action":"enable"}' \
  "$BASE/v1/admin/credentials/<credential-uuid>" | jq
```

- Wrong credential **revoked**: revocation is terminal and `enable` will refuse
  it with `CREDENTIAL_REVOKED` (HTTP 409). This is deliberate — the endpoint that
  removes a leaked token must not be able to restore it. Issue a replacement
  credential instead.
- Prefer issuing a **new** credential over re-enabling one that may have been
  exposed at all.
