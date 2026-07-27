#!/usr/bin/env bash
# Wrapper kept for runbook compatibility. Prefer: node scripts/print-database-ca.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/print-database-ca.mjs
