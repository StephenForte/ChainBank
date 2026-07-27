# AGENTS.md

## Purpose

This file defines mandatory coding, testing, operational, and security standards for all human and AI contributors to ChainBank.

ChainBank controls a transaction-signing wallet. Treat every code path that can influence a destination address, transfer amount, chain, nonce, authorization decision, or signing credential as security-sensitive.

## 1. Working Agreement

1. Read this file before changing code.
2. Make the smallest coherent change that satisfies the current phase and acceptance criteria.
3. Do not add speculative framework layers or future-phase features without an approved requirement.
4. Preserve backward compatibility unless the change explicitly includes a migration plan.
5. Never weaken a security check to make a test pass.
6. Never commit secrets, wallet private keys, seed phrases, API tokens, live database URLs, or real `.env` files.
7. When uncertain about a security-sensitive behavior, stop and document the question rather than guessing.

## 2. Required Technology Conventions

- Language: TypeScript.
- Runtime: Node.js active LTS supported by project dependencies.
- API framework: Fastify.
- EVM library: Viem.
- ORM: Drizzle.
- Hosted database: PostgreSQL.
- Tests: Vitest.
- Package manager: use the repository lockfile and `npm ci` in CI.
- Local development must not require Docker.

Do not introduce an alternative web framework, ORM, blockchain library, test runner, or package manager without an architectural decision record.

## 3. Repository Structure

Preferred boundaries:

```text
src/
  app/                 # application use cases
  domain/              # pure domain models and rules
  api/                 # Fastify routes, schemas, auth hooks
  infrastructure/
    db/                # Drizzle schema and repositories
    evm/               # Viem clients, signer, transaction tracking
    email/             # provider adapters
    config/            # validated runtime configuration
  jobs/                # cron entry points
  observability/       # logging, metrics, correlation IDs
  shared/              # narrowly scoped shared utilities

test/
  unit/
  integration/
  e2e/
```

Rules:

- Route handlers must not contain funding calculations or transaction-signing logic.
- Domain modules must not import Fastify, Drizzle, Viem clients, Resend, or process environment variables.
- Infrastructure adapters implement interfaces defined by application/domain layers.
- Cron entry points call the same application services as the API; they do not duplicate business logic.

## 4. TypeScript Standards

- Enable `strict` mode and keep it enabled.
- Do not use `any`. Use `unknown` at boundaries and narrow it.
- Avoid non-null assertions (`!`) except where a documented invariant is enforced immediately beforehand.
- Prefer discriminated unions for operation states and error results.
- Prefer immutable values and `readonly` fields.
- Export explicit public types; avoid leaking vendor-specific types across boundaries.
- Use exhaustive checks for status/state switches.
- Never represent wei, token quantities, gas, chain IDs, or nonces as JavaScript floating-point numbers.
- Use `bigint` in application code and decimal/numeric database columns with explicit conversion.
- Decimal ETH strings are UI/config input only and must be parsed once at a validated boundary.

## 5. Naming and Style

- Files and directories: kebab-case unless framework conventions require otherwise.
- Types/classes: PascalCase.
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE only for true constants.
- Boolean names begin with `is`, `has`, `can`, `should`, or `requires`.
- Use precise domain names: `minimumBalanceWei`, not `min`; `treasuryReserveWei`, not `buffer`.
- Avoid abbreviations unless standard in the domain (`rpc`, `tx`, `id`).
- Functions should be small enough that security preconditions and effects are obvious.
- Comments explain why and invariants, not what the syntax already says.

Formatting and linting are automated. Do not manually fight the configured formatter.

## 6. Error Handling

- Use stable machine-readable error codes.
- Separate safe client messages from internal diagnostic context.
- Never return stack traces, provider credentials, RPC URLs containing secrets, raw signed transactions, authorization headers, or environment variables.
- Classify errors as validation, authentication, authorization, conflict, unavailable dependency, retriable provider failure, transaction rejected, transaction reverted, or internal error.
- RPC failure must never be interpreted as a zero balance.
- Database failure must prevent signing if the operation cannot be durably recorded.
- Catch errors only when adding context, converting them to a domain error, compensating safely, or terminating an entry point cleanly.
- Do not silently swallow promise rejections.

## 7. Security Invariants

These invariants are mandatory and require tests.

### 7.1 Destination allowlist

- Service credentials may fund only registered, enabled managed wallets within their authorized project/environment.
- Never accept an arbitrary destination address from a project-service caller.
- Operator-only administrative endpoints that alter wallet registration require audit logging.

### 7.2 Chain verification

- Verify the connected RPC chain ID before every signing workflow.
- Refuse to sign when configured and observed chain IDs differ.
- Chain configuration is immutable during a single operation.

### 7.3 Amount safety

- Funding amount is calculated from fresh balance, target policy, maximum top-up, reserve, and estimated gas.
- Validate all values as non-negative integers.
- Never use floating-point arithmetic for blockchain amounts.
- Re-run reserve and policy checks immediately before signing.
- No “send all,” sweep, or unlimited amount feature in MVP code.

### 7.4 Treasury reserve

- A transfer must not reduce spendable treasury balance below configured reserve plus conservative transaction cost.
- Reserve checks fail closed when gas cost cannot be estimated safely.

### 7.5 Idempotency and concurrency

- Mutating funding endpoints require an idempotency key where specified by the PRD.
- Persist idempotency state before submitting a transaction.
- Enforce one transaction dispatcher per treasury/chain using a database-backed lock or equivalent reviewed mechanism.
- Detect an existing pending funding transaction before creating another for the same wallet.
- Retry only after reconciling transaction hash, nonce, replacement, and receipt state.

### 7.6 Secret handling

- Secrets enter through validated runtime configuration or an approved external signer.
- Do not write secrets to Postgres.
- Do not log secrets, even at debug level.
- Redact common credential fields centrally.
- The read-only treasury monitor must run without treasury signing credentials.
- Test fixtures use generated disposable keys only.

### 7.7 Authentication and authorization

- Authentication is required for every non-public endpoint unless explicitly documented as public.
- Authorization is enforced in application services, not only route middleware.
- Credentials are scoped to roles and projects/environments.
- Deny by default.
- Audit authorization-relevant changes.

## 8. API Standards

- Version application endpoints under `/v1`.
- Define Fastify JSON schemas for request, response, params, and query strings.
- Reject unknown fields on security-sensitive requests.
- Use UUIDs or stable opaque identifiers externally; do not expose sequential database IDs.
- Use ISO 8601 UTC timestamps.
- Return wei quantities as decimal strings in JSON.
- Include a correlation/request ID in responses and logs.
- Mutating endpoints document idempotency behavior.
- Pagination is required for unbounded collections.
- Do not expose internal database column names as an accidental public contract.

## 9. Database Standards

- All schema changes use committed Drizzle migrations.
- Migrations are deterministic and reviewed.
- Foreign keys and uniqueness constraints enforce core invariants in addition to application checks.
- Use transactions for multi-row state changes.
- Use explicit locking for funding dispatch and idempotency races.
- Store blockchain numeric quantities in `numeric(78,0)` or a reviewed equivalent.
- Store normalized addresses and preserve a checksummed display form where useful.
- Funding and audit records are append-oriented; never delete them to hide an error.
- Cron jobs close their connection pool before exit.
- Avoid N+1 queries in dashboard and reconciliation paths.

## 10. EVM and Viem Standards

- Separate public-client reads from wallet-client signing.
- Construct the wallet client only in signing-capable processes.
- Use explicit chain definitions.
- Validate addresses with Viem utilities.
- Wait for and inspect receipts according to configured confirmation policy.
- Handle reverted, replaced, dropped, and pending transactions as distinct states.
- Store transaction hash as soon as submission succeeds.
- Never assume a successful RPC submission means confirmation.
- Keep gas configuration conservative and bounded.
- Do not implement custom cryptography.

## 11. Logging and Observability

- Hosted logs are structured JSON.
- Every request, cron run, funding operation, and transaction has a correlation/operation ID.
- Log state transitions, not secret payloads.
- Wallet addresses may be logged when operationally necessary; avoid combining them with sensitive identity data.
- Never log private keys, signed raw transactions, auth tokens, cookies, full database URLs, or email-provider secrets.
- Metrics names are stable and low-cardinality.
- Alert on repeated cron failures, repeated transaction failures, and inability to serve legitimate funding due to reserve.

## 12. Testing Requirements

Every feature must include the smallest appropriate set of tests.

### Unit tests

Required for:

- policy validation
- top-up calculation
- reserve calculation
- alert transitions
- authorization rules
- idempotency state machine
- error mapping

### Integration tests

Required for:

- Drizzle repositories and constraints
- transaction boundaries and locks
- concurrent ensure-funding requests
- RPC adapter behavior
- email adapter behavior

### End-to-end tests

Required for each phase’s primary workflow.

Test rules:

- Tests must not depend on public faucets.
- Tests must not spend from the real treasury by default.
- Network-dependent tests are opt-in and clearly labeled.
- Security regression tests accompany every fixed vulnerability.
- Time-dependent logic uses an injected clock.
- Random identifiers use an injected or deterministic generator when assertions require stability.

## 13. CI Quality Gates

A pull request is not mergeable unless all applicable checks pass:

- format check
- lint
- TypeScript typecheck
- unit tests
- integration tests
- build
- dependency vulnerability scan
- secret scan
- migration validation

Do not bypass checks with blanket ignores. Any temporary exception requires a linked issue, owner, reason, and expiration date.

## 14. Dependency Policy

- Prefer platform APIs and existing dependencies over adding packages.
- New dependencies require a clear need, active maintenance, acceptable license, and security review.
- Avoid packages for trivial helpers.
- Pin through the lockfile.
- Do not run install scripts from untrusted packages without review.
- Remove unused dependencies promptly.

## 15. Pull Request Standards

Every pull request should include:

- problem and phase/user-story reference
- implementation summary
- security impact
- migration/configuration changes
- tests added
- operational or rollback notes
- screenshots only when UI changes are relevant, with secrets removed

Keep PRs focused. Separate mechanical refactoring from behavior changes when practical.

## 16. Commit Standards

- Write imperative, descriptive commit messages.
- Do not include secrets in commits, even if later removed.
- Do not rewrite shared history without coordination.
- Keep generated build output out of Git unless explicitly required.

## 17. Configuration Standards

- Validate all environment variables at startup with a typed schema.
- Fail fast on missing required configuration.
- Keep public addresses and policy values configurable.
- Separate common, read-only, signing, database, and email secrets by service role.
- Provide `.env.example` with placeholders only.
- Never default to a production or mainnet chain.
- The default funding mode in new environments is disabled/read-only.

## 18. Operational Safety

- Provide a global kill switch that disables all transaction submission while preserving read-only status.
- Provide per-project, per-environment, per-wallet, and per-treasury enable flags.
- A disabled entity cannot be funded by API or cron.
- Manual “check now” is read-only.
- Policy changes do not retroactively modify historical transaction records.
- Runbooks must exist before enabling scheduled signing in a hosted environment.

## 19. Prohibited Changes Without Explicit Approval

- Mainnet support.
- Real-value asset custody.
- Arbitrary destination transfers.
- Browser automation against public faucets.
- Storing treasury keys in the database.
- Logging raw signed transactions.
- Disabling reserve checks.
- Removing idempotency or locking.
- Adding a public unauthenticated funding endpoint.
- Introducing upgradeable smart contracts or custom cryptography.

## 20. Definition of Done for Coding Agents

Before declaring a task complete:

1. Map the change to a PRD phase, user story, and acceptance criteria.
2. Confirm security invariants affected by the change.
3. Implement the smallest coherent solution.
4. Add or update tests.
5. Run format, lint, typecheck, tests, and build.
6. Review logs and error responses for secret leakage.
7. Review database and transaction concurrency behavior.
8. Update documentation, `.env.example`, migrations, and runbooks as applicable.
9. Summarize remaining risks or open questions honestly.
10. Do not claim success when any required check was skipped or failed.
