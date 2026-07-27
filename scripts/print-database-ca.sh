#!/usr/bin/env bash
# Prints the Postgres server certificate PEM for DATABASE_SSL_CA.
# Run inside the Render web-service shell where DATABASE_URL is set.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set in this shell." >&2
  exit 1
fi

HOST="$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname)")"
PORT="$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.port || '5432')")"

echo "Connecting to ${HOST}:${PORT} …" >&2
openssl s_client -starttls postgres -showcerts -connect "${HOST}:${PORT}" </dev/null 2>/dev/null \
  | openssl x509 -outform PEM
