# ChainBank

[![CI](https://github.com/StephenForte/ChainBank/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenForte/ChainBank/actions/workflows/ci.yml)

Treasury and wallet-funding service for EVM development environments.

Humans replenish the treasury with testnet ETH. ChainBank monitors balances, alerts operators by email, and (from Phase 1 onward) funds approved managed wallets according to policy.

**Current phase: Phase 1 in progress — treasury MVP and on-demand funding.**  
This build can observe the Sepolia treasury, persist observations, and send a test email. **It cannot send ETH yet.** The Phase 1 foundation is merged (schema for wallets/policies/funding, pure funding math, and a fail-closed `TreasurySigner` adapter), but there is no dispatch path or funding endpoint, so no process can submit a transaction. Task status lives in [`tasks/worker-plan.md`](./tasks/worker-plan.md).

## Stack

| Layer              | Choice                                     |
| ------------------ | ------------------------------------------ |
| Language / runtime | TypeScript, Node.js 22+                    |
| API                | Fastify                                    |
| ORM / DB           | Drizzle + PostgreSQL                       |
| Chain reads        | Viem public client (Sepolia only)          |
| Email              | Resend (or `log-only` locally)             |
| Dashboard          | React + Vite (served by Fastify)           |
| Tests              | Vitest (unit / integration / e2e projects) |
| Hosting target     | Render (web service + cron + Postgres)     |

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

| Method | Path                       | Auth              | Purpose                            |
| ------ | -------------------------- | ----------------- | ---------------------------------- |
| `GET`  | `/health/live`             | none              | Liveness                           |
| `GET`  | `/health/ready`            | none              | Readiness + shared DB heartbeats   |
| `GET`  | `/v1/treasuries`           | bearer            | List treasuries / last observation |
| `POST` | `/v1/treasuries/:id/check` | bearer            | Fresh on-chain balance check       |
| `POST` | `/v1/admin/email/test`     | bearer (operator) | Send test email                    |

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

| Script                     | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `npm run dev`              | API with reload                              |
| `npm run dev:dashboard`    | Vite dashboard (proxies `/v1` and `/health`) |
| `npm run build`            | Compile server + dashboard                   |
| `npm start`                | Run compiled web service                     |
| `npm run db:migrate`       | Apply Drizzle migrations                     |
| `npm run db:generate`      | Generate a migration from schema changes     |
| `npm run credential:issue` | Create a hashed API credential               |
| `npm test`                 | Unit tests (default)                         |
| `npm run test:coverage`    | Unit tests with coverage report              |
| `npm run test:integration` | Opt-in Postgres tests                        |
| `npm run test:e2e`         | Opt-in e2e tests                             |
| `npm run typecheck`        | `tsc --noEmit`                               |
| `npm run lint`             | ESLint                                       |
| `npm run format:check`     | Prettier check                               |

## Testing

Every pull request and push to `main` runs the [CI workflow](.github/workflows/ci.yml) (format, lint, typecheck, unit tests, build, dependency audit, secret scan, migration validation, and integration tests).

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

| Metric     | Coverage                   |
| ---------- | -------------------------- |
| Statements | ~35%                       |
| Branches   | ~32%                       |
| Functions  | ~26%                       |
| Lines      | ~35%                       |
| Unit tests | 38 passing across 10 files |

High coverage where it matters first: `domain/wei`, treasury status, roles, config loader, auth, logger redaction, and the treasury-check use case. Low/zero coverage remains on Fastify routes, Drizzle repositories, and EVM/email adapters — those need the opt-in integration/e2e suites tomorrow.

Integration and e2e projects are wired but still placeholders until local Postgres verification.

## Security notes

- Keep `FUNDING_ENABLED=false` in every deployment until Phase 1 dispatch lands. Enabling it requires a structurally valid `TREASURY_PRIVATE_KEY` for the signing role; the signer fails closed on absent or malformed key config, and the treasury-monitor cron never receives the key.
- Sepolia is the only supported chain ID; mainnet is rejected at startup.
- RPC failures become status `unknown`, never a fabricated zero balance.
- Bearer tokens are stored as SHA-256 hashes; the raw token is shown once.
- Authorization is enforced in application services, not only route middleware.
- Secrets are redacted in structured logs.
- See [`AGENTS.md`](./AGENTS.md) for mandatory contributor rules.

## Deploy (Render)

Deploy from `main` only after CI is green (see the status badge above).

Phase 0 Blueprint lives in [`render.yaml`](./render.yaml): web service, daily treasury-monitor cron, and shared Postgres. **No signing key on any service.**

Follow the operator checklist: [`docs/runbooks/deploy-render-phase0.md`](./docs/runbooks/deploy-render-phase0.md).

Short version:

1. Push `main` (includes Blueprint + dashboard build).
2. Render → **New** → **Blueprint** → connect this repo.
3. Fill `sync: false` secrets (RPC, hot-wallet treasury, Resend, thresholds, `PUBLIC_BASE_URL`).
4. Confirm `FUNDING_ENABLED=false` and no `TREASURY_PRIVATE_KEY`.
5. Issue an operator credential against the Render DB, then smoke `/health/ready`, treasury check, test email, and a manual cron run.

## Product docs

- [`tasks/ChainBank_PRD_v4.md`](./tasks/ChainBank_PRD_v4.md) — full PRD and phased plan
- [`AGENTS.md`](./AGENTS.md) — engineering and security standards

## Phase roadmap (short)

| Phase       | Focus                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| 0 ✅        | Bootstrap, shared Postgres, treasury balance, test email — no ETH movement |
| **1** (now) | Managed wallets, funding policy, on-demand funding, reserve                |
| 2           | Projects / environments / `ensure-ready`                                   |
| 3           | Daily treasury alerts (warning / critical / recovery)                      |
| 4           | Scheduled wallet reconciliation                                            |
| 5+          | ERC-20, multi-chain, CLI / Actions, production evaluation                  |
