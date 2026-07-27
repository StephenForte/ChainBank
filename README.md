# ChainBank

Treasury and wallet-funding service for EVM development environments.

Humans replenish the treasury with testnet ETH. ChainBank monitors balances, alerts operators by email, and (from Phase 1 onward) funds approved managed wallets according to policy.

**Current phase: Phase 0 — Bootstrap and read-only monitoring.**  
This build can observe the Sepolia treasury, persist observations, and send a test email. **It cannot send ETH.** There is no wallet client or signing path in the tree.

## Stack

| Layer | Choice |
| --- | --- |
| Language / runtime | TypeScript, Node.js 22+ |
| API | Fastify |
| ORM / DB | Drizzle + PostgreSQL |
| Chain reads | Viem public client (Sepolia only) |
| Email | Resend (or `log-only` locally) |
| Dashboard | React + Vite (served by Fastify) |
| Tests | Vitest (unit / integration / e2e projects) |
| Hosting target | Render (web service + cron + Postgres) |

Local development does **not** require Docker. Use [Postgres.app](https://postgresapp.com/) or a Homebrew Postgres install.

## Repository layout

```text
src/
  app/             Application use cases
  domain/          Pure domain rules (no Fastify/Drizzle/Viem/env)
  api/             Fastify routes and plugins
  infrastructure/  DB, EVM read adapter, email adapters
  config/          Validated runtime configuration
  jobs/            Cron entry points
  observability/   Structured logging
dashboard/         React operator UI (build artifact)
test/
  unit/            Default `npm test` suite
  integration/     Opt-in Postgres tests
  e2e/             Opt-in workflow tests
tasks/             Product requirements (PRD)
```

## Prerequisites

- Node.js 22+
- npm (lockfile-based; use `npm ci` in CI)
- Local PostgreSQL
- Sepolia RPC URL and treasury address
- Optional: Resend API key for a real test email

## Quick start

```bash
git clone https://github.com/StephenForte/ChainBank.git
cd ChainBank
npm ci

# Create a local database
createdb chainbank

# Configure
cp .env.example .env
# Edit .env with DATABASE_URL, CHAIN_RPC_URL, TREASURY_ADDRESS, email settings

# Migrate and start
npm run db:migrate
npm run credential:issue -- --name "operator-local" --role operator
npm run dev
```

The API listens on `http://localhost:3000` by default.

Issue a credential once; the raw token is printed a single time and only the hash is stored.

### Useful endpoints (Phase 0)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health/live` | none | Liveness |
| `GET` | `/health/ready` | none | Readiness + shared DB heartbeats |
| `GET` | `/v1/treasuries` | bearer | List treasuries / last observation |
| `POST` | `/v1/treasuries/:id/check` | bearer | Fresh on-chain balance check |
| `POST` | `/v1/admin/email/test` | bearer (operator) | Send test email |

Example:

```bash
export TOKEN='cb_…'   # from credential:issue

curl -s http://localhost:3000/health/ready | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/treasuries | jq
```

### Treasury monitor cron (local)

```bash
npm run build:server
npm run cron:treasury-monitor
```

The cron process loads the `treasury-monitor` config role: no email provider credentials, bounded DB pool, closes connections before exit.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API with reload |
| `npm run dev:dashboard` | Vite dashboard (proxies `/v1` and `/health`) |
| `npm run build` | Compile server + dashboard |
| `npm start` | Run compiled web service |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run credential:issue` | Create a hashed API credential |
| `npm test` | Unit tests (default) |
| `npm run test:coverage` | Unit tests with coverage report |
| `npm run test:integration` | Opt-in Postgres tests |
| `npm run test:e2e` | Opt-in e2e tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format:check` | Prettier check |

## Testing

Vitest is configured with three projects:

1. **unit** — pure domain, config, auth, and service tests. No network, no Postgres. This is `npm test`.
2. **integration** — repositories and shared-DB behavior. Opt-in.
3. **e2e** — full workflows against local Postgres / mocked providers. Opt-in.

Run coverage:

```bash
npm run test:coverage
```

Opt into database-backed suites:

```bash
createdb chainbank_test
export DATABASE_URL=postgres://localhost:5432/chainbank_test
export CHAINBANK_RUN_INTEGRATION=true
npm run db:migrate
npm run test:integration
```

### Current coverage (Phase 0 bootstrap)

As of the initial unit suite (`npm run test:coverage`):

| Metric | Coverage |
| --- | --- |
| Statements | ~35% |
| Branches | ~32% |
| Functions | ~26% |
| Lines | ~35% |
| Unit tests | 38 passing across 10 files |

High coverage where it matters first: `domain/wei`, treasury status, roles, config loader, auth, logger redaction, and the treasury-check use case. Low/zero coverage remains on Fastify routes, Drizzle repositories, and EVM/email adapters — those need the opt-in integration/e2e suites tomorrow.

Integration and e2e projects are wired but still placeholders until local Postgres verification.

## Security notes (Phase 0)

- No treasury private key is accepted for signing. `FUNDING_ENABLED` must stay `false`.
- Sepolia is the only supported chain ID; mainnet is rejected at startup.
- RPC failures become status `unknown`, never a fabricated zero balance.
- Bearer tokens are stored as SHA-256 hashes; the raw token is shown once.
- Authorization is enforced in application services, not only route middleware.
- Secrets are redacted in structured logs.
- See [`AGENTS.md`](./AGENTS.md) for mandatory contributor rules.

## Deploy (Render) — next step after local verification

Phase 0 targets:

1. Render Web Service (`npm run build` / `npm start`)
2. Render Postgres (shared `DATABASE_URL`)
3. Render Cron Job for `npm run cron:treasury-monitor`
4. Migrations on deploy (`npm run db:migrate:built`)

Blueprint / GitHub Actions config is still to be added after local smoke testing. Until then, do not enable any signing secrets on Render.

## Product docs

- [`tasks/ChainBank_PRD_v4.md`](./tasks/ChainBank_PRD_v4.md) — full PRD and phased plan
- [`AGENTS.md`](./AGENTS.md) — engineering and security standards

## Phase roadmap (short)

| Phase | Focus |
| --- | --- |
| **0** (now) | Bootstrap, shared Postgres, treasury balance, test email — no ETH movement |
| 1 | Managed wallets, funding policy, on-demand funding, reserve |
| 2 | Projects / environments / `ensure-ready` |
| 3 | Daily treasury alerts (warning / critical / recovery) |
| 4 | Scheduled wallet reconciliation |
| 5+ | ERC-20, multi-chain, CLI / Actions, production evaluation |
