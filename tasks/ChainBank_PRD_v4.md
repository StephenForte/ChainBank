# ChainBank Product Requirements Document

**Version:** 4.0  
**Status:** Engineering-ready draft  
**Initial customer:** ForteL2  
**Initial network:** Ethereum Sepolia  
**Hosting target:** Render  
**Primary notification channel:** Email

## 1. Executive Summary

ChainBank is a treasury and wallet-funding service for EVM development environments. It removes the need for developers, deployment scripts, CI systems, and long-running application services to visit public faucets or manually transfer testnet ETH.

A human operator remains responsible for acquiring external testnet ETH. ChainBank monitors the treasury, emails the operator when a refill is required, and automatically distributes available ETH to authorized managed wallets according to centrally defined policies.

The first production use is ForteL2 on Ethereum Sepolia. ChainBank is an independent repository and is designed from the beginning to support multiple projects, environments, wallet roles, and EVM networks.

## 2. Problem Statement

ForteL2 and related development systems use multiple wallets. Several wallets require a minimum native-token balance at startup and can continue consuming gas while services remain active. Public faucet availability is inconsistent, eligibility rules are opaque, and manual redistribution is repetitive and error-prone.

The system needs to separate two concerns:

1. **External acquisition:** A human obtains testnet ETH from Alchemy, QuickNode, another faucet, or another wallet.
2. **Internal distribution:** ChainBank ensures authorized application wallets have enough ETH to operate.

## 3. Product Vision

> ChainBank is the internal bank for development environments: humans replenish the treasury; software automatically keeps approved wallets operational.

## 4. Goals

- Eliminate manual funding of application and CI wallets.
- Guarantee critical wallets meet startup minimums before dependent services proceed.
- Keep long-running managed wallets funded through scheduled reconciliation.
- Alert the operator by email before the treasury becomes unable to serve projects.
- Centralize funding policy by project, environment, chain, and wallet role.
- Maintain an auditable ledger of observations, decisions, transfers, failures, and alerts.
- Run without Docker during normal local development.
- Deploy from GitHub to Render using a Node.js runtime and a shared Render Postgres database.

## 5. Non-Goals for the MVP

- Automatically bypassing or scripting public faucet eligibility systems.
- Minting native Sepolia ETH.
- Mainnet wallet management or real-money treasury operations.
- General custody for third parties.
- Arbitrary public faucet access.
- ERC-20 asset provisioning in the first release.
- Multi-chain support in the first release.
- A mobile application.

## 6. Personas

### 6.1 Operator

Owns the testnet treasury, receives email alerts, replenishes it, reviews transactions, and manages projects and policies.

### 6.2 Application Developer

Runs or deploys ForteL2 and expects required wallets to be ready without visiting faucets or calculating transfer amounts.

### 6.3 Application Startup Coordinator

Calls ChainBank before startup and blocks or warns according to the readiness result.

### 6.4 Scheduled Reconciliation Job

Periodically checks active wallets and tops up those below minimum policy levels.

### 6.5 CI System

Requests funding for approved CI wallets or ephemeral environments without exposing the treasury key.

## 7. Core Domain Model

### 7.1 Project

A product or codebase managed by ChainBank, such as ForteL2 or SettlementOS.

### 7.2 Environment

A project-specific context such as development, CI, demo, or staging.

### 7.3 Chain

An EVM network. Ethereum Sepolia is the only required chain for the MVP.

### 7.4 Treasury

A long-lived wallet holding testnet ETH and acting as the source of internal funding.

### 7.5 Managed Wallet

An approved wallet associated with a project, environment, chain, and role.

### 7.6 Funding Policy

Rules defining when and how a managed wallet may be funded:

- minimum balance
- target balance
- maximum top-up per operation
- critical-at-startup flag
- enabled/disabled state
- reconciliation eligibility

### 7.7 Balance Observation

A timestamped on-chain balance reading for a treasury or managed wallet.

### 7.8 Funding Transaction

A requested or completed transfer from a treasury to a managed wallet.

### 7.9 Alert

A stateful notification record for warning, critical, recovery, funding failure, or unresolved-reminder events.

## 8. Product Principles

### 8.1 Human acquisition, automated distribution

ChainBank does not claim public faucets. It alerts the operator, observes the replenishment on-chain, and resumes distribution automatically.

### 8.2 Minimum and target are different

A wallet is funded only when below its minimum. It is restored to its target. This hysteresis avoids repeated tiny transactions.

### 8.3 The chain is the source of truth

Database balances are observations, not authoritative balances. Funding decisions require a current RPC read.

### 8.4 Idempotent by default

Startup calls and scheduled checks may repeat safely. The same logical operation must not produce duplicate transfers.

### 8.5 Preserve a treasury reserve

No funding operation may reduce the treasury below its configured reserve.

### 8.6 Least privilege

Read-only monitoring does not receive signing credentials. Only transaction-signing processes have access to the treasury key.

## 9. Deployment Architecture

One GitHub repository deploys multiple Render resources:

1. **ChainBank Web Service**
   - REST API
   - operator dashboard
   - startup funding requests
   - administrative actions

2. **Treasury Monitor Cron Job**
   - runs daily
   - reads treasury balance
   - records observations
   - manages low-balance and recovery email alerts
   - does not need the treasury private key

3. **Managed Wallet Reconciliation Cron Job**
   - initially runs every six hours
   - checks enabled managed wallets
   - funds wallets below minimum
   - requires signing capability

4. **Render Postgres**
   - shared persistent database used by the web service and cron jobs

All services use the same codebase. Shared environment groups may provide common non-secret configuration. Services that sign transactions receive a separate secret group.

## 10. End-to-End Workflows

### 10.1 Treasury Refill Workflow

1. Daily cron reads the treasury balance from Sepolia.
2. ChainBank compares the balance with warning and critical thresholds.
3. If healthy, the job records the observation and exits silently.
4. If low, ChainBank sends an email and records alert state.
5. The operator obtains Sepolia ETH and sends it to the treasury address.
6. The next scheduled or manual check sees the higher on-chain balance.
7. ChainBank marks the alert resolved and sends a recovery email.
8. No manual “resume” action is required.

### 10.2 Application Startup Workflow

1. ForteL2 startup orchestration calls `POST /v1/environments/{environmentId}/ensure-ready`.
2. ChainBank loads all enabled wallets marked for startup checks.
3. ChainBank reads current balances from Sepolia.
4. For each wallet below minimum, ChainBank calculates the amount required to reach target.
5. ChainBank applies per-operation limits and treasury-reserve rules.
6. ChainBank serializes treasury transactions and submits transfers.
7. ChainBank waits for the required confirmation policy.
8. ChainBank returns `ready`, `degraded`, `pending`, or `blocked` with wallet-level details.
9. ForteL2 proceeds, warns, waits, or fails based on criticality.

### 10.3 Scheduled Reconciliation Workflow

1. Cron acquires a reconciliation lock.
2. It loads enabled wallets eligible for reconciliation.
3. It performs fresh on-chain balance reads.
4. It tops up only wallets below minimum.
5. It stops before breaching the treasury reserve.
6. It records observations and transaction outcomes.
7. It sends an operator email for repeated or systemic failures.

## 11. Phased Delivery Plan

## Phase 0 - Bootstrap and Read-Only Monitoring

**Goal:** Establish the repository, deployment, shared database, balance reads, and email delivery without moving funds.

### User Story P0-US1: Deploy ChainBank

As an operator, I want ChainBank deployed from GitHub to Render so the service runs without Docker on my local machine.

**Acceptance Criteria**

- The repository builds with `npm ci && npm run build`.
- The web service starts with `npm start`.
- Local development runs with `npm run dev` and no Docker requirement.
- A Render Web Service deploys from the repository.
- A Render Postgres database is provisioned.
- Database migrations execute successfully.
- The web service can read and write a health-check row.

### User Story P0-US2: Share Postgres Across Services

As an operator, I want the API and cron job to use the same database so alert state and observations are consistent.

**Acceptance Criteria**

- The web service and treasury cron receive connection details for the same Render Postgres database.
- A row written by the web service is readable by the cron job.
- A row written by the cron job is readable by the web service.
- Each process uses bounded connection pooling appropriate to its lifecycle.
- Cron processes close database connections before exiting.

### User Story P0-US3: Observe Treasury Balance

As an operator, I want to see the current Sepolia treasury balance so I know whether external funding is required.

**Acceptance Criteria**

- Treasury address is configuration, not source code.
- The service verifies the configured chain ID before reporting a balance.
- Balance is retrieved through the configured RPC endpoint.
- Balance is stored internally as wei using integer-safe types.
- The dashboard shows address, chain, current balance, status, and last checked time.
- RPC failures are displayed as unknown/unavailable, never as a zero balance.

### User Story P0-US4: Receive Test Email

As an operator, I want to send a test email so I know alerts will reach me.

**Acceptance Criteria**

- Email recipient and sender are configuration values.
- Resend is supported as the initial provider.
- A protected admin action sends a test email.
- The result is logged without storing provider credentials or full sensitive payloads.

### Phase 0 Exit Criteria

- Treasury balance is visible.
- Daily cron runs successfully.
- Shared Postgres operation is demonstrated.
- Test email is received.
- No process can send ETH yet.

## Phase 1 - Treasury MVP and On-Demand Funding

**Goal:** Eliminate manual transfer of ETH from the treasury to approved application wallets.

### User Story P1-US1: Register a Managed Wallet

As an operator, I want to register a wallet under a project and environment so ChainBank can manage it safely.

**Acceptance Criteria**

- Wallet requires project, environment, chain, role, and address.
- Address is validated and normalized.
- Duplicate active wallet registrations for the same chain and address are rejected.
- Private keys for managed recipient wallets are never requested or stored.
- Wallet can be enabled or disabled.
- Changes are auditable.

### User Story P1-US2: Define Funding Policy

As an operator, I want minimum and target balances configured centrally so applications do not hardcode funding amounts.

**Acceptance Criteria**

- Minimum, target, and maximum top-up are stored in wei.
- Target must be greater than or equal to minimum.
- Maximum top-up must be positive.
- Critical-at-startup and reconciliation-enabled flags are supported.
- Invalid policy combinations are rejected.
- Policy changes are auditable.

### User Story P1-US3: Ensure One Wallet Is Funded

As a developer, I want ChainBank to ensure an approved wallet has enough ETH so I do not manually fund it.

**Acceptance Criteria**

- A protected endpoint accepts a managed wallet identifier, not an arbitrary destination address.
- ChainBank performs a fresh on-chain balance read.
- If balance is at or above minimum, no transaction is sent.
- If balance is below minimum, the calculated top-up aims for target.
- Top-up respects maximum-top-up and treasury-reserve constraints.
- The endpoint returns before/target/transfer values and transaction status.
- Repeating the same idempotency key does not create a second transfer.
- A pending transfer to the same wallet prevents duplicate funding.

### User Story P1-US4: View Funding History

As an operator, I want to review funding history so I can understand where treasury ETH went.

**Acceptance Criteria**

- History includes project, environment, role, destination, amount, transaction hash, state, initiator, and timestamps.
- Transaction hashes link to the configured block explorer.
- Results can be filtered by project, environment, wallet, status, and date.
- Failed and abandoned transactions remain visible.

### User Story P1-US5: Preserve Treasury Reserve

As an operator, I want ChainBank to retain a reserve so automated wallets cannot drain the treasury completely.

**Acceptance Criteria**

- Reserve is configurable per treasury.
- Funding is rejected when the post-transfer balance would fall below reserve plus estimated gas.
- Rejection returns a stable machine-readable reason.
- A critical operator email is generated when legitimate demand cannot be served due to reserve constraints.

### Phase 1 Exit Criteria

- ForteL2 can fund an approved wallet without a manual transfer.
- Duplicate startup calls do not duplicate payments.
- Treasury reserve behavior is tested.
- All transactions are auditable.

## Phase 2 - Projects, Environments, and Environment Readiness

**Goal:** Make ChainBank a reusable multi-project service and integrate directly with ForteL2 startup.

### User Story P2-US1: Manage Projects and Environments

As an operator, I want wallets grouped by project and environment so policies and dashboards remain understandable.

**Acceptance Criteria**

- Projects have unique stable slugs.
- Environments belong to exactly one project.
- Wallets belong to exactly one environment and one chain.
- Projects and environments can be disabled without deleting history.
- Dashboard filters and API authorization can scope by project and environment.

### User Story P2-US2: Ensure an Environment Is Ready

As ForteL2 startup orchestration, I want one call to ensure all required wallets are ready so startup behavior is deterministic.

**Acceptance Criteria**

- Endpoint checks all enabled startup-managed wallets for the environment.
- Wallet-level results include no-op, funded, pending, warning, or blocked.
- Critical wallet failure produces overall `blocked`.
- Noncritical wallet failure produces overall `degraded`.
- All successful checks produce `ready`.
- Request supports an idempotency key.
- Concurrent requests for the same environment do not create duplicate transfers.
- Response is suitable for machine parsing and operator troubleshooting.

### User Story P2-US3: Startup Wait and Confirmation

As a developer, I want startup to wait for funding confirmation so dependent services do not start with unusable wallets.

**Acceptance Criteria**

- Confirmation count and timeout are configurable.
- Timeout returns `pending`, not a false failure.
- A later status query can resume tracking the same operation.
- Transaction replacement and reverted transactions are handled explicitly.

### Phase 2 Exit Criteria

- ForteL2 uses environment readiness as its startup integration point.
- Critical and noncritical startup behavior is demonstrated.
- Multiple projects can coexist without policy leakage.

## Phase 3 - Daily Treasury Monitoring and Email Alerts

**Goal:** Trigger the operator’s human refill workflow before treasury depletion affects applications.

### User Story P3-US1: Daily Treasury Check

As an operator, I want the treasury checked daily on Render so monitoring does not depend on my Mac or the web process remaining active.

**Acceptance Criteria**

- A Render Cron Job runs on the configured schedule.
- The job reads the current on-chain treasury balance.
- The job records an observation and evaluation result.
- The job exits with success when the balance is healthy.
- RPC or database failures produce a failed run and an actionable operational log.

### User Story P3-US2: Warning and Critical Email

As an operator, I want email alerts at warning and critical thresholds so I have time to replenish funds.

**Acceptance Criteria**

- Warning, critical, recovery, and reminder thresholds are configurable.
- Exactly one warning email is sent when transitioning from healthy to warning.
- Exactly one critical email is sent when transitioning to critical.
- Repeated daily checks do not send duplicates while state is unchanged.
- An unresolved reminder may be sent after the configured interval.
- Email includes chain, treasury address, observed balance, threshold, recommended action, and dashboard link.

### User Story P3-US3: Automatic Recovery Detection

As an operator, I want ChainBank to detect an external refill automatically so I do not need to click a resume button.

**Acceptance Criteria**

- A later balance check detects that recovery threshold is satisfied.
- Open warning/critical alert state is resolved.
- One recovery email is sent.
- Funding APIs immediately use the newly available on-chain balance.
- A protected manual “check now” action is available.

### Phase 3 Exit Criteria

- Warning, critical, reminder, and recovery paths are tested end-to-end.
- The monitoring job has no treasury signing key.
- External refill requires no database edit or restart.

## Phase 4 - Automatic Managed-Wallet Reconciliation

**Goal:** Keep long-running application wallets operational without waiting for restart.

### User Story P4-US1: Scheduled Reconciliation

As an operator, I want managed wallets checked periodically so active systems remain funded.

**Acceptance Criteria**

- A separate Render Cron Job runs at the configured interval.
- Only enabled, reconciliation-eligible wallets are included.
- Fresh balances are read before each funding decision.
- Wallets at or above minimum are not funded.
- Wallets below minimum are topped up according to policy.
- Treasury reserve is never breached.
- Run-level summary is stored.

### User Story P4-US2: Prevent Concurrent Funding

As an operator, I want concurrent jobs and API calls coordinated so the treasury does not issue duplicate transactions or conflicting nonces.

**Acceptance Criteria**

- One transaction-dispatch lock exists per treasury and chain.
- Wallet-level pending funding prevents duplicate top-ups.
- Nonce is obtained and managed inside the serialized transaction boundary.
- Lock expiration and crash recovery are tested.
- The system safely retries retriable failures without creating duplicate transfers.

### User Story P4-US3: Reconciliation Failure Alert

As an operator, I want email after repeated funding failures so silent degradation does not continue.

**Acceptance Criteria**

- Single transient failures are logged but do not immediately spam email.
- Configurable consecutive failure count triggers an alert.
- Alert includes affected wallets and error categories.
- Recovery is recorded after a successful run.

### Phase 4 Exit Criteria

- Long-running ForteL2 wallets remain above policy minimum during a test period.
- API and cron concurrency tests pass.
- Failure and recovery alerting works.

## Phase 5 - ERC-20 Asset Provisioning

**Goal:** Ensure development wallets also hold required mock assets.

### User Stories and Acceptance Criteria

- As a developer, I can define target balances for approved mock ERC-20 tokens.
- ChainBank can transfer or mint only explicitly configured development tokens.
- Token contracts, decimals, and permissions are validated.
- Native ETH and token readiness appear in one environment response.
- Production or unknown token contracts are rejected by default.

## Phase 6 - Multi-Chain Support

**Goal:** Extend the same model beyond Ethereum Sepolia.

### User Stories and Acceptance Criteria

- Chain adapters expose a common balance, transfer, confirmation, and explorer interface.
- Policies are chain-specific.
- Each chain has an independent treasury, reserve, nonce lock, and RPC configuration.
- Failure on one chain does not block unrelated chains.
- Base Sepolia is the first additional implementation.

## Phase 7 - CLI and GitHub Actions

**Goal:** Make ChainBank easy to invoke from developer and CI workflows.

### User Stories and Acceptance Criteria

- CLI supports status, ensure-wallet, ensure-environment, and transaction lookup.
- GitHub Action uses short-lived scoped credentials.
- Secret values are masked from logs.
- CI callers cannot alter projects or funding policies.

## Phase 8 - Production Evaluation

**Goal:** Evaluate whether the architecture can support real-value operational wallets.

This is a separate security, compliance, key-management, and risk project. No production funds may be introduced merely by enabling a configuration flag.

## 12. Functional Requirements

### 12.1 API

Initial endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /v1/treasuries`
- `POST /v1/treasuries/{id}/check`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/environments/{id}`
- `POST /v1/environments/{id}/ensure-ready`
- `GET /v1/wallets`
- `POST /v1/wallets`
- `POST /v1/wallets/{id}/ensure-funded`
- `GET /v1/funding-transactions`
- `POST /v1/admin/email/test`

All mutating requests require authentication, authorization, request validation, audit context, and idempotency where applicable.

### 12.2 Dashboard

MVP dashboard views:

- treasury status and last observation
- open alerts
- projects and environments
- managed wallets and policy status
- recent funding transactions
- failed operations
- manual check-now action
- test-email action

The dashboard must never display private keys, seed phrases, raw provider secrets, full authorization tokens, or encrypted secret material.

### 12.3 Email Templates

Required templates:

- treasury warning
- treasury critical
- unresolved reminder
- treasury recovery
- funding unavailable due to reserve
- repeated reconciliation failure
- test message

## 13. Suggested Data Model

### projects

- id UUID primary key
- slug unique
- name
- enabled
- created_at
- updated_at

### environments

- id UUID primary key
- project_id foreign key
- slug
- name
- enabled
- created_at
- updated_at
- unique(project_id, slug)

### chains

- id UUID primary key
- slug unique
- chain_id unique
- display_name
- native_symbol
- rpc_configuration_key
- explorer_base_url
- enabled

### treasuries

- id UUID primary key
- chain_id foreign key
- address
- warning_balance_wei numeric(78,0)
- critical_balance_wei numeric(78,0)
- recovery_balance_wei numeric(78,0)
- minimum_reserve_wei numeric(78,0)
- status
- last_observed_balance_wei numeric(78,0)
- last_checked_at
- enabled

### managed_wallets

- id UUID primary key
- environment_id foreign key
- chain_id foreign key
- role
- address
- enabled
- critical_at_startup
- reconciliation_enabled
- created_at
- updated_at
- unique(chain_id, address)

### funding_policies

- id UUID primary key
- managed_wallet_id unique foreign key
- minimum_balance_wei numeric(78,0)
- target_balance_wei numeric(78,0)
- maximum_top_up_wei numeric(78,0)
- version integer
- created_at
- updated_at

### balance_observations

- id UUID primary key
- chain_id foreign key
- wallet_address
- wallet_type
- balance_wei numeric(78,0)
- block_number numeric(78,0)
- observed_at
- source_operation_id nullable

### funding_operations

- id UUID primary key
- operation_type
- project_id nullable
- environment_id nullable
- idempotency_key nullable
- status
- requested_by
- started_at
- completed_at
- error_code nullable
- error_summary nullable
- unique(requested_by, idempotency_key) where idempotency_key is not null

### funding_transactions

- id UUID primary key
- operation_id foreign key
- treasury_id foreign key
- managed_wallet_id foreign key
- amount_wei numeric(78,0)
- transaction_hash nullable
- nonce nullable
- status
- error_code nullable
- created_at
- submitted_at nullable
- confirmed_at nullable

### alerts

- id UUID primary key
- alert_type
- severity
- entity_type
- entity_id
- state
- first_triggered_at
- last_evaluated_at
- last_sent_at nullable
- resolved_at nullable
- metadata_json

### audit_events

- id UUID primary key
- actor_type
- actor_id
- action
- entity_type
- entity_id
- request_id
- source_ip nullable
- metadata_json
- created_at

## 14. Authentication and Authorization

MVP roles:

- **operator:** full administration and funding visibility
- **project-service:** ensure funding/read status only for assigned projects and environments
- **read-only:** dashboard and transaction visibility without mutation
- **cron-treasury-monitor:** read treasury, write observations and alert state; no signing
- **cron-reconciler:** read policies and submit authorized top-ups

Requirements:

- Service credentials are scoped and independently revocable.
- Tokens are stored hashed where possible.
- Authorization is checked after authentication and before database mutation or RPC signing.
- Arbitrary destination addresses are prohibited for non-operator service calls.
- Operator actions that change funding policy are audited.

## 15. Security Requirements

### 15.1 Key Material

- No private keys or seed phrases in source control, logs, database rows, tests, fixtures, or screenshots.
- Treasury signing key is provided only at runtime through Render secrets.
- Read-only monitoring cron must not have the signing key.
- Key access is isolated behind a signer interface.
- The application must fail closed when signing configuration is absent or malformed.
- Secrets must never be included in exception objects returned to clients.

### 15.2 Transaction Safety

- Allowlisted managed-wallet destinations only.
- Chain ID must be verified before signing.
- Transfer value must be computed from validated integer quantities.
- Treasury reserve and maximum-top-up checks occur immediately before signing.
- Per-treasury transaction serialization prevents nonce collisions.
- Pending and replaced transactions are reconciled before retry.
- Gas estimation failure must not fall back to an unsafe unlimited transfer path.

### 15.3 API Security

- TLS is mandatory in hosted environments.
- Strict schema validation rejects unknown or malformed fields on security-sensitive endpoints.
- Rate limits apply by credential, project, and endpoint.
- CORS is deny-by-default and explicitly configured.
- Administrative browser sessions require CSRF protection if cookie-based auth is used.
- Security headers are enabled.
- Errors expose stable codes and safe summaries, not stack traces.

### 15.4 Database Security

- Parameterized queries only through Drizzle or reviewed SQL.
- Least-privilege database credentials where practical.
- Migrations are reviewed and backward-compatible within a phase.
- Audit and funding history are append-oriented.
- Sensitive metadata is minimized and retention is documented.

### 15.5 Supply Chain

- Lockfile is committed.
- CI uses `npm ci`.
- Dependency changes are reviewed.
- Automated vulnerability scanning runs in CI.
- Production dependencies are minimized.
- Build artifacts are reproducible from the committed source and lockfile.

## 16. Non-Functional Requirements

### Reliability

- Repeated identical requests are safe.
- Cron jobs may be retried without duplicate transfers.
- RPC failures never become false zero balances.
- Database unavailability prevents signing rather than allowing unrecorded transfers.

### Performance

- Read-only status endpoints target p95 under 500 ms excluding provider latency.
- Environment readiness should parallelize balance reads within provider limits.
- Transaction submission remains serialized per treasury.

### Observability

- Structured JSON logs in hosted environments.
- Every request and scheduled run has a correlation ID.
- Logs include operation IDs and safe wallet identifiers.
- Metrics include check success, RPC failures, funding attempts, confirmed transfers, alert transitions, and treasury balance.

### Maintainability

- TypeScript strict mode.
- Domain logic separated from Fastify handlers, database adapters, email providers, and Viem clients.
- External providers are wrapped in testable interfaces.
- No blockchain floating-point math.

## 17. Technology Stack

- Node.js current active LTS supported by chosen dependencies
- TypeScript
- Fastify
- Viem
- Drizzle ORM
- PostgreSQL on Render
- SQLite or temporary PostgreSQL for local/unit testing as appropriate
- Vitest
- React/Vite dashboard, introduced only when required by phase scope
- Resend for MVP email
- GitHub Actions for CI
- Docker optional for portability, not required for local development

## 18. Testing Strategy

### Unit Tests

- policy validation
- funding amount calculation
- reserve calculation
- alert-state transitions
- authorization decisions
- idempotency behavior
- error classification

### Integration Tests

- PostgreSQL repositories
- RPC adapter against mocked JSON-RPC
- signer adapter with deterministic test accounts
- Resend adapter mocked at HTTP boundary
- concurrent funding requests

### End-to-End Tests

- local development chain or isolated Sepolia test wallet
- environment readiness no-op
- environment readiness top-up
- insufficient treasury reserve
- warning to recovery email lifecycle
- cron retry behavior

No automated test may spend from the real configured treasury unless explicitly marked and manually enabled.

## 19. Operational Runbooks

Required before Phase 3 exit:

- replenish treasury
- rotate treasury key
- rotate service token
- investigate failed funding
- recover from stuck/pending nonce
- disable a compromised project credential
- disable all automated funding
- restore database
- verify cron execution
- change thresholds safely

## 20. Definition of Done

A phase is complete only when:

- all phase acceptance criteria pass
- automated tests cover new domain behavior
- security-sensitive paths receive explicit review
- database migration and rollback/forward strategy are documented
- Render deployment is verified
- observability and operator error messages are present
- documentation and runbooks are updated
- no regression exists in prior phases
- no secrets appear in repository history or build output

## 21. Initial Configuration Example

```yaml
chainbank:
  environment: hosted-development
  email:
    provider: resend
    from: chainbank@example.com
    operatorRecipients:
      - operator@example.com

chains:
  ethereum-sepolia:
    chainId: 11155111
    nativeSymbol: ETH
    explorerBaseUrl: https://sepolia.etherscan.io

projects:
  fortel2:
    environments:
      development:
        wallets:
          deployer:
            addressEnv: FORTE_DEPLOYER_ADDRESS
            minimumBalanceEth: '0.02'
            targetBalanceEth: '0.05'
            maximumTopUpEth: '0.05'
            criticalAtStartup: true
            reconciliationEnabled: true
```

Addresses and secrets remain runtime configuration. The PRD does not contain live private keys or fixed personal wallet addresses.

## 22. Open Questions

- Should the signing key remain a Render secret for the MVP or be delegated to an external signer before Phase 1?
- Should the dashboard use operator API tokens initially or add an identity provider?
- What exact warning, critical, recovery, and reserve balances fit ForteL2’s observed gas consumption?
- How many confirmations should startup require on Sepolia?
- Should Phase 1 use SQLite locally and Postgres hosted, or standardize development on a locally installed Postgres without Docker?

## 23. Render Implementation Notes

Render Cron Jobs can execute commands from the same repository on schedules defined in Render. Render environment groups can be linked to multiple services. A Render Postgres database exposes connection details that multiple Render services can use; a Render Blueprint can inject a database connection into a cron job with `fromDatabase`. The API and cron jobs therefore share one logical database while remaining separate processes.

## 24. References

- Render Cron Jobs: https://render.com/docs/cronjobs
- Render Postgres connections: https://render.com/docs/postgresql-creating-connecting
- Render environment variables and groups: https://render.com/docs/configure-environment-variables
- Render projects and environments: https://render.com/docs/projects
- Render example of a cron job using `fromDatabase`: https://render.com/docs/backup-postgresql-to-s3
