# ChainBank

[![CI](https://github.com/StephenForte/ChainBank/actions/workflows/ci.yml/badge.svg)](https://github.com/StephenForte/ChainBank/actions/workflows/ci.yml)

Treasury and wallet-funding service for EVM development environments.

Humans replenish the treasury with testnet ETH. ChainBank monitors balances, alerts operators by email, and (from Phase 1 onward) funds approved managed wallets according to policy.

**Current phase: Phases 1–4 are code-complete.** The reconciliation use case
(C14), the 6-hourly reconciler cron, failure alerting (C15), the incremental
outgoing scan (TX.9, migration `0005`), cron-vs-API concurrency coverage (C16),
and crash-duplicate prevention (TX.10, C7 amendment) are all merged and deployed.
Phase 4 is **not yet declared exited**: its §20 criterion that wallets remain
above policy minimum during a test period has no live evidence, because no
managed wallet has `reconciliation_enabled = true` yet.

This build observes the Sepolia treasury, alerts operators by email on
warning/critical/recovery transitions, manages projects, environments, wallets and
funding policies, funds approved managed wallets through
`POST /v1/wallets/:id/ensure-funded`, and can sweep an entire environment through
`POST /v1/environments/:id/ensure-ready` (contract [C11](./tasks/DECISIONS.md#c11--environment-ensure-ready-owner-t22)).

**Production funding is armed** (2026-08-01): hosted verification passed all four
phases and the operator released the kill switch. New deployments still default to
`FUNDING_ENABLED=false` until you deliberately arm them — see
[`docs/runbooks/verify-hosted-deployment.md`](./docs/runbooks/verify-hosted-deployment.md)
and [`disable-all-automated-funding.md`](./docs/runbooks/disable-all-automated-funding.md).
Treasury key rotation is API-driven via `PATCH /v1/treasuries/:id` (contract
[C12](./tasks/DECISIONS.md#c12--treasury-row-lifecycle-owner-tx5)); the runbook index
**Known gaps** table is current as of TX.5. Task status lives in
[`tasks/worker-plan.md`](./tasks/worker-plan.md).

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
docs/runbooks/     Operator procedures
tasks/             PRD, task plan, decisions, security reviews
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

### Endpoints

All `/v1` routes require a bearer token. Wei quantities cross the API as decimal
strings; timestamps are ISO 8601 UTC; list endpoints are paginated.

| Method  | Path                                | Auth                               | Purpose                                                                                                                                          |
| ------- | ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/health/live`                      | none                               | Liveness                                                                                                                                         |
| `GET`   | `/health/ready`                     | none                               | Readiness + shared DB heartbeats                                                                                                                 |
| `GET`   | `/v1/treasuries`                    | bearer                             | List treasuries / last observation                                                                                                               |
| `PATCH` | `/v1/treasuries/:id`                | operator                           | Enable / disable a treasury row ([C12](./tasks/DECISIONS.md#c12--treasury-row-lifecycle-owner-tx5))                                              |
| `POST`  | `/v1/treasuries/:id/check`          | bearer                             | Fresh on-chain check (read-only, evaluates alerts)                                                                                               |
| `GET`   | `/v1/projects`                      | bearer                             | List projects (scoped)                                                                                                                           |
| `POST`  | `/v1/projects`                      | operator                           | Create a project                                                                                                                                 |
| `GET`   | `/v1/projects/:id`                  | bearer                             | Project detail                                                                                                                                   |
| `PATCH` | `/v1/projects/:id`                  | operator                           | Enable / disable without deleting history                                                                                                        |
| `GET`   | `/v1/projects/:id/environments`     | bearer                             | List environments for a project (paginated; [C13](./tasks/DECISIONS.md#c13--list-environments-for-a-project-owner-tx7))                          |
| `POST`  | `/v1/projects/:id/environments`     | operator                           | Create an environment                                                                                                                            |
| `GET`   | `/v1/environments/:id`              | bearer                             | Environment detail                                                                                                                               |
| `PATCH` | `/v1/environments/:id`              | operator                           | Enable / disable without deleting history                                                                                                        |
| `POST`  | `/v1/environments/:id/ensure-ready` | operator or scoped project-service | **Ensure all enabled wallets in an environment** (idempotency key required; [C11](./tasks/DECISIONS.md#c11--environment-ensure-ready-owner-t22)) |
| `GET`   | `/v1/wallets`                       | bearer                             | List managed wallets (filterable)                                                                                                                |
| `POST`  | `/v1/wallets`                       | operator                           | Register a managed wallet                                                                                                                        |
| `PATCH` | `/v1/wallets/:id`                   | operator                           | Enable / disable a wallet                                                                                                                        |
| `PUT`   | `/v1/wallets/:id/policy`            | operator                           | Set minimum / target / maximum top-up                                                                                                            |
| `POST`  | `/v1/wallets/:id/ensure-funded`     | operator or scoped project-service | **Fund a wallet to target** (idempotency key required)                                                                                           |
| `GET`   | `/v1/funding-operations/:id`        | bearer                             | Operation status; resumes confirmation tracking                                                                                                  |
| `GET`   | `/v1/funding-transactions`          | bearer                             | Funding history with filters                                                                                                                     |
| `GET`   | `/v1/admin/credentials`             | operator                           | List API credentials (paginated; no secrets)                                                                                                     |
| `PATCH` | `/v1/admin/credentials/:id`         | operator                           | Disable, revoke, or re-enable a credential (`action`)                                                                                            |
| `POST`  | `/v1/admin/email/test`              | operator                           | Send test email                                                                                                                                  |

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

The cron process loads the `treasury-monitor` config role: email settings for alert delivery, bounded DB pool, closes connections before exit. It never receives `TREASURY_PRIVATE_KEY`.

### Wallet reconciler cron (local)

```bash
npm run build:server
npm run cron:wallet-reconciler
```

Loads the `cron-reconciler` config role: DB, chain/RPC, funding/signer settings, thresholds, lookback (`RECONCILE_OUTGOING_LOOKBACK_BLOCKS`), and email (for failure alerting). Signing-capable — set `TREASURY_PRIVATE_KEY` only when `FUNDING_ENABLED=true`. Records a `wallet-reconciler` heartbeat, closes the pool before exit. Funding disabled / kill switch exits **zero** (policy); DB/RPC run-level failures exit **non-zero**.

## Scripts

| Script                           | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `npm run dev`                    | API with reload                              |
| `npm run dev:dashboard`          | Vite dashboard (proxies `/v1` and `/health`) |
| `npm run build`                  | Compile server + dashboard                   |
| `npm start`                      | Run compiled web service                     |
| `npm run cron:treasury-monitor`  | Daily treasury check (local)                 |
| `npm run cron:wallet-reconciler` | Six-hourly reconciliation (local)            |
| `npm run db:migrate`             | Apply Drizzle migrations                     |
| `npm run db:generate`            | Generate a migration from schema changes     |
| `npm run credential:issue`       | Create a hashed API credential               |
| `npm test`                       | Unit tests (default)                         |
| `npm run test:coverage`          | Unit tests with coverage report              |
| `npm run test:integration`       | Opt-in Postgres tests                        |
| `npm run test:e2e`               | Opt-in e2e tests                             |
| `npm run typecheck`              | `tsc --noEmit`                               |
| `npm run lint`                   | ESLint                                       |
| `npm run format:check`           | Prettier check                               |

### Operator dashboard

The React console under `dashboard/` is built into `dist/dashboard` and served by
the Fastify web process. Locally, run `npm run dev` plus `npm run dev:dashboard`
(Vite proxies `/v1` and `/health` same-origin).

MVP views (PRD §12.2 / P2-US1):

- Session (operator bearer token in `sessionStorage` only), service readiness, treasuries, funding history
- Projects (list + enable/disable)
- Environments (list for a selected project via `GET /v1/projects/:id/environments`, detail by id, enable/disable)
- Managed wallets (filters, explorer links, enable/disable)
- Funding policy (ETH input converted once to decimal wei strings; confirm shows the exact wei body)

Panels load and fail independently. Mutations confirm before firing. The dashboard
never renders private keys, seed phrases, or raw credential material.

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

### Current coverage

| Suite             | Count                              |
| ----------------- | ---------------------------------- |
| Unit tests        | 381 passing across 45 files        |
| Integration tests | 69 passing (opt-in, real Postgres) |

Unit-suite line coverage is ~49% overall, concentrated where correctness is
load-bearing: the funding math, alert state machine, status state machines,
authorization matrix, idempotency, config loading, and logger redaction are at or
near full branch coverage. The uncovered remainder is mostly wiring —
`container.ts`, route registration, and adapters — which the integration suite
exercises end to end instead.

The e2e project is wired but still empty, and stays that way: decision D6 was
reconfirmed on 2026-08-02 and **superseded**. CI runs `npm run test:integration`
and never `npm run test:e2e`, so an Anvil-backed e2e suite that skips when the
binary is absent would let a Phase 4 exit criterion be met by a suite that runs
nowhere. Phase 4's cron-versus-API concurrency work (T4.4) therefore lands in the
integration suite instead, against real Postgres advisory locks — where the
serialization actually happens — with a nonce-rejecting signer fake standing in
for node-level nonce rejection. A real-chain Anvil harness is deferred, not
dropped.

## Security notes

- `POST /v1/wallets/:id/ensure-funded` funds only registered managed wallets. The request body accepts an idempotency key only (`additionalProperties: false`); destination addresses are resolved exclusively from the database (AGENTS.md §7.1).
- Keep `FUNDING_ENABLED=false` until you have deliberately decided to arm funding. Enabling requires a structurally valid `TREASURY_PRIVATE_KEY` on signing-capable roles; the dispatch engine and signer fail closed on kill switch, disabled entities, chain mismatch, signer/treasury address mismatch, and DB unavailability. The treasury-monitor cron never receives the key. The emergency stop is [`disable-all-automated-funding.md`](./docs/runbooks/disable-all-automated-funding.md) — note it takes effect only after the signing process restarts.
- Sepolia is the only supported chain ID; mainnet is rejected at startup.
- RPC failures become status `unknown`, never a fabricated zero balance.
- Bearer tokens are stored as SHA-256 hashes; the raw token is shown once.
- Authorization is enforced in application services, not only route middleware. Operator and scoped project-service credentials may fund; read-only and cron roles cannot.
- Secrets are redacted in structured logs.
- See [`AGENTS.md`](./AGENTS.md) for mandatory contributor rules.

## Deploy (Render)

Deploy from `main` only after CI is green (see the status badge above).

The Blueprint in [`render.yaml`](./render.yaml) provisions a web service, the daily
treasury-monitor cron, the six-hourly wallet-reconciler cron, and shared Postgres.
`TREASURY_PRIVATE_KEY` is declared only on signing-capable services (web +
wallet-reconciler) — never on the treasury-monitor.

Follow the operator checklist: [`docs/runbooks/deploy-render-phase0.md`](./docs/runbooks/deploy-render-phase0.md).
Operational incident runbooks (PRD §19): [`docs/runbooks/README.md`](./docs/runbooks/README.md).

Short version:

1. Push `main` (includes Blueprint + dashboard build).
2. Render → **New** → **Blueprint** → connect this repo.
3. Fill `sync: false` secrets (RPC, hot-wallet treasury, Resend, thresholds, `PUBLIC_BASE_URL`).
4. Confirm `FUNDING_ENABLED=false` and no `TREASURY_PRIVATE_KEY`.
5. Issue an operator credential against the Render DB, then smoke `/health/ready`, treasury check, test email, and a manual cron run.

## Product docs

- [`tasks/ChainBank_PRD_v4.md`](./tasks/ChainBank_PRD_v4.md) — full PRD and phased plan, with an implementation-status appendix
- [`tasks/worker-plan.md`](./tasks/worker-plan.md) — task breakdown and current status
- [`tasks/DECISIONS.md`](./tasks/DECISIONS.md) — cross-task decisions, interface contracts, config registry
- [`tasks/SECURITY-REVIEW-T1.5.md`](./tasks/SECURITY-REVIEW-T1.5.md) — review of the dispatch engine
- [`tasks/SECURITY-REVIEW-T1.6.md`](./tasks/SECURITY-REVIEW-T1.6.md) — review of the funding endpoint
- [`AGENTS.md`](./AGENTS.md) — engineering and security standards

## Phase roadmap (short)

| Phase | Focus                                                                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Bootstrap, shared Postgres, treasury balance, test email — no ETH movement | ✅ complete                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1     | Managed wallets, funding policy, on-demand funding, reserve                | ✅ complete (including reserve-exhaustion email and concurrency integration tests)                                                                                                                                                                                                                                                                                                                                                                                   |
| 2     | Projects / environments / `ensure-ready`                                   | ✅ complete — scoped auth, operation status, dashboard views, `ensure-ready` (C11), list-environments (C13)                                                                                                                                                                                                                                                                                                                                                          |
| 3     | Daily treasury alerts (warning / critical / recovery)                      | ✅ complete — alert lifecycle, emails, PRD §19 runbooks, hosted verification passed (2026-08-01)                                                                                                                                                                                                                                                                                                                                                                     |
| 4     | Scheduled wallet reconciliation                                            | code-complete, awaiting live evidence — use case (T4.1, C14, migration `0004`), 6-hourly reconciler cron (T4.2), failure alerting (T4.3, C15), incremental forward-contiguous outgoing scan (TX.9, migration `0005`), cron-vs-API concurrency tests (T4.4, C16), and crash-duplicate prevention (TX.10, C7) all merged. Not exited: no wallet has `reconciliation_enabled = true`, so the "wallets stay above minimum during a test period" criterion is unevidenced |
| 5+    | ERC-20, multi-chain, CLI / Actions, production evaluation                  | out of scope for this effort                                                                                                                                                                                                                                                                                                                                                                                                                                         |
