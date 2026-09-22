# Create a dashboard user

Dashboard login (C31) uses an email and a password. The password is stored as a
scrypt hash. Treasury keys are not part of this flow and must not be written
to Postgres.

The first admin has to be created from a machine that can reach the database,
the same way an API credential is issued. Later users are created from
`POST /v1/admin/users` by an admin session.

## Steps

1. From a checkout with `DATABASE_URL` pointing at the target database:

   ```bash
   npm run user:create -- --email operator@example.com --name "Ada Lovelace" --role admin
   ```

2. Type the password when prompted. The prompt does not echo it. You can also
   pipe it. The password is not an argument and not an environment variable.
   Fewer than 12 characters is refused.

   ```bash
   printf '%s\n' 'a-long-password' | npm run user:create -- --email operator@example.com --name "Ada Lovelace" --role admin
   ```

3. The command prints the user id, email, name, and role. It does not print the
   password or the hash. If the email already exists it exits without changing
   the row.

## After that

Sign in with `POST /v1/auth/login`. The session cookie is `chainbank_session`
(`HttpOnly`, `SameSite=Strict`, `Secure` when the process is hosted). Cookie
requests must also send `X-ChainBank-Session: 1`. API bearer tokens are
unchanged and are still how scripts and CI authenticate.

An admin who disables or demotes their own account is refused. Keep a second
admin, the same way a second operator credential is kept for API tokens.
