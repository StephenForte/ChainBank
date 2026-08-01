# ChainBank operator runbooks

Operational procedures for hosted ChainBank. Read these **before** enabling
funding (`FUNDING_ENABLED=true`) in any hosted environment (PRD §19 / §20,
AGENTS.md §18).

Phase 0 deploy checklist (Blueprint, TLS pin, first credential):
[`deploy-render-phase0.md`](./deploy-render-phase0.md).

## Index — use this when…

| Runbook                                                                                    | Use this when…                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [`replenish-treasury.md`](./replenish-treasury.md)                                         | The hot-wallet treasury is low on Sepolia ETH and funding or alerts need a refill.                           |
| [`rotate-treasury-key.md`](./rotate-treasury-key.md)                                       | The treasury signing key must be replaced (compromise, rotation policy, or new hot wallet).                  |
| [`rotate-service-token.md`](./rotate-service-token.md)                                     | An API bearer token must be replaced as a planned rotation (not an active compromise).                       |
| [`investigate-failed-funding.md`](./investigate-failed-funding.md)                         | An ensure-funded call or funding row failed / stuck and you have an error code or transaction status.        |
| [`recover-stuck-pending-nonce.md`](./recover-stuck-pending-nonce.md)                       | A funding row is in-flight (`created` / `submitted` / `submission_unknown`) and blocking further top-ups.    |
| [`disable-compromised-project-credential.md`](./disable-compromised-project-credential.md) | A project-service (or other) credential may be leaked and must stop authenticating immediately.              |
| [`disable-all-automated-funding.md`](./disable-all-automated-funding.md)                   | Emergency stop — halt every signing path now while keeping read-only monitoring up.                          |
| [`restore-database.md`](./restore-database.md)                                             | Postgres must be restored from a Render backup after data loss or corruption.                                |
| [`verify-cron-execution.md`](./verify-cron-execution.md)                                   | You need to confirm the treasury-monitor or wallet-reconciler cron ran (or diagnose a missed / failed run).  |
| [`verify-hosted-deployment.md`](./verify-hosted-deployment.md)                             | You need to confirm a Render deployment actually works — after a deploy, or before arming funding (PRD §20). |
| [`change-thresholds-safely.md`](./change-thresholds-safely.md)                             | Warning / critical / recovery / reserve ETH thresholds must change without editing the database.             |

## Known gaps

Capabilities operators need that **do not exist** in this repository today.
Runbooks that depend on them use parameterized SQL (or provider UI) and call that
out as a **manual workaround**. Do not invent scripts or endpoints to fill these.

| Gap                                                                 | Impact                                                                                                       | Workaround today                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `FUNDING_KILL_SWITCH` is env-only (no runtime toggle)               | Kill switch takes effect only after the signing process reloads config (redeploy / restart)                  | Set the env var on `chainbank-web` and **Manual Deploy** / restart (runbook 7)                                   |
| No automated resolver for `submission_unknown` funding transactions | Ambiguous submissions stay in-flight (block duplicates + count against reserve) until Phase 4 reconciliation | Observe nonce on-chain by hand; do not invent a terminal status (runbook 5; see `tasks/SECURITY-REVIEW-T1.5.md`) |
| No in-repo database backup/restore tooling                          | Restore is entirely a Render Postgres provider operation                                                     | Render Dashboard backup restore, then verify migrate + readiness (runbook 8)                                     |

Closed previously:

- **Treasury enable/disable API** — `PATCH /v1/treasuries/:id` `{ "enabled": boolean }`
  (operator-only, audited). Rotation no longer needs SQL; see
  [`rotate-treasury-key.md`](./rotate-treasury-key.md).

## Operational prerequisites

- **Two operator credentials.** The credential admin API refuses to mutate the
  token making the request, so disabling or rotating an operator credential
  requires a second one. Issue and store both before you need them — see
  [`deploy-render-phase0.md`](./deploy-render-phase0.md) step 4.

## Rules for every runbook

- Prefer API / npm scripts / Render UI that exist in this repo (`package.json`,
  `src/api/routes/`, `scripts/`, `render.yaml`).
- Never paste real private keys, bearer tokens, database URLs, or live addresses
  into tickets or commits — placeholders only.
- Funding and audit rows are append-oriented (AGENTS.md §9): never `DELETE` them
  to hide an error.
- When funding is involved, prefer the emergency stop
  ([`disable-all-automated-funding.md`](./disable-all-automated-funding.md))
  over improvising SQL against `funding_transactions`.
