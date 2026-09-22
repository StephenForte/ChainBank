# ChainBank Phase 10 Plan — Operator Console v2 (login, layout, chain filter, email visibility)

Planner-owned. Goal: satisfy PRD Phase 10 — a dashboard an operator can live in now that there are
two chains: user login instead of a pasted token, a sidebar layout with compact panels and collapsible
detail, a chain filter (ALL / per chain), an Admin page, and an Email page that shows what can send
mail, to whom, and what was sent.

Authority: `tasks/ChainBank_PRD_v4.md` Phase 10, `tasks/DECISIONS.md` (D24; C20, C22 still bind the
dashboard), `AGENTS.md` (§7.6 no secrets in Postgres, §7.7 deny by default, §14 dependencies, §19
prohibited changes), and the
[commit and merge contract](./worker-plan.md#commit-and-merge-contract) in `tasks/worker-plan.md`.
Phase 6 is code-complete but **not exited** (`p6-plan.md`); this phase runs after the 18:00 UTC
evidence run and TX.33, and does not touch the money path.

Baseline at plan write: `origin/main` **`a3cc9fc`** (2026-09-22). Verified: **76 files / 655 unit**,
**3 files / 48 dashboard**, **27 files / 132 integration**, 0 skipped.

## Identifiers reserved by this plan (do not grep-and-increment)

| Kind      | Assigned                                                                                            | Next free after this phase |
| --------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| Contract  | **C31** T10.1 · **C32** T10.2 · **C33** T10.3 · **C34** T10.4 · **C35** T10.5 · **C36** T10.6       | **C37**                    |
| Migration | **0011** T10.1 (users + sessions) · **0012** T10.5 (email deliveries)                               | **0013**                   |
| Decision  | **D24** (written with this plan; supersedes D2 for the dashboard only)                              | **D25**                    |
| Task id   | **T10.1**–**T10.6** below. TX.32 and TX.33 stay reserved in `p6-plan.md`; next free TX is **TX.34** | —                          |

T10.5 must rebase onto a merged T10.1 **before** running `npm run db:generate`, so its file is
`0012_*`. If any other task believes it needs a migration, stop and ask the planner.

## What the operator asked for, and how this plan reads it

The request (2026-09-22): use the Figma "CRM Dashboard Customers List" (community file 1146467298668328949) as inspiration for layout (left sidebar) and style; a UID/password login stored
securely in Postgres so others can log in; a simple Admin option in the sidebar where a user "can
store their key"; an Email dashboard page showing which triggers are set, to whom, and a log of
emails; a cleaner main page with smaller panels and an ALL / ETH / BASE filter that scales to more
chains; hide detail behind +/− wherever possible.

**Assumptions the planner made, flagged for the operator.** Each changes the work materially if wrong.

1. **"Store their key" means the operator no longer pastes an API token at all.** Login creates a
   server-side session; the session carries the user's role; the dashboard calls the API with the
   session cookie. The Admin page lets an admin manage users and issue or revoke _API credentials_
   (the existing hashed-token store) for scripts and CI. Nothing secret is written to Postgres beyond
   password hashes and session-token hashes, which is what AGENTS.md §7.6 permits. If "key" meant a
   **treasury private key**, that is prohibited by AGENTS.md §19 ("storing treasury keys in the
   database") and D-level approval would be needed first; this plan does not do it.
2. **Roles.** Users have one of `admin` (manage users and credentials, everything else), `operator`
   (maps to the existing `operator` API role), `viewer` (maps to `read-only`). The first admin is
   created by a CLI script against the database, the same way `scripts/issue-credential.ts` works
   today; no password ever lives in an environment variable.
3. **The chain filter is derived from the registered chains**, never a hard-coded ETH/BASE pair, so a
   third chain appears without a UI change. "ALL" is the default and is remembered per browser.
4. **No new runtime dependencies.** Password hashing is Node's `crypto.scrypt`; cookies are parsed
   and set with a few lines, not `@fastify/cookie`; page routing is hash-based, not `react-router`;
   fonts are the system stack because the CSP forbids third-party assets. Any worker who believes a
   dependency is needed argues it in the PR under AGENTS.md §14 rather than adding it.

## Design reference, in words (workers cannot open the Figma file without an account)

The reference is a light CRM dashboard: a fixed **left sidebar** (~250 px, white, logo top-left, a
vertical nav with an icon and label per item, the active item filled with the accent colour, a
small user block at the bottom); a **content area** on a pale grey page background (`#f5f6fa`
range) with a greeting/title row and a search or filter control top-right; a row of **stat cards**
(white, 16–20 px radius, soft shadow, a coloured icon disc, a big number, a small label and delta);
then **tables** in white cards with a title, a search box, a sort control, zebra-free rows, status
**pills** (green `Active`, red/pink `Inactive`), and pagination at the foot. One accent colour
(purple, `#5932ea` range) for the active nav item, primary buttons and links; dark near-black text;
muted grey secondary text. That is the whole vocabulary this phase adopts. Keep ChainBank's own
words (Public / Private, Healthy / Warning / Critical) and its green for healthy.

Hard constraints that survive the redesign:

- **C20:** unacknowledged critical findings are never hidden behind a collapse and never filtered
  out by the chain filter's default. C22's per-panel error boundaries remain, one per page section.
- Numbers keep full precision where money is shown; a stat card may round, a table row does not.
- The dashboard stays same-origin, CSP unchanged, CORS `credentials: false`.

## Task tree

Legend: 🔴 strongest model (auth boundary, sessions, anything that writes to the DB) · 🟢 cheaper
model OK. `[deps]` must merge first. Every task carries the commit-and-merge contract.

### T10.1 🔴 Users, sessions, login API — **C31**, migration **0011** `[none]`

**Status 2026-09-22: ✅ reviewed and approved in
[#134](https://github.com/StephenForte/ChainBank/pull/134); operator merges.** Planner re-ran the gate
in a scratch clone (668 unit / 48 dashboard / 138 integration), proved 0011 forward on a populated
0010 database (rows intact, `actor_type` gains `dashboard_user` and is usable after the migration),
and probed six cases the worker's suite does not cover: bearer beside a valid cookie authenticates as
the credential; CSRF header values other than `1` and a duplicated cookie are rejected; disabling a
user kills a live session on the next request; absolute and idle expiry are enforced to the
millisecond; viewer → read-only and admin → operator reach the existing routes; unknown email and
wrong password are indistinguishable in body and within 3× in time. Bootstrap after T10.3:
`npm run user:create` against the hosted database creates the first admin.

Owns: `src/domain/auth/users.ts` (new), `src/app/auth/{login,logout,session,users}*.ts` (new),
`src/infrastructure/db/repositories/{dashboard-user,dashboard-session}-repository.ts` (new),
`src/api/routes/auth.ts` (new), `src/api/routes/admin-users.ts` (new), `scripts/create-dashboard-user.ts`
(new), tests. Additive on the shared files `src/infrastructure/db/schema.ts`, `src/app/ports.ts`,
`src/container.ts`, `src/api/app.ts`, `src/api/plugins/authentication.ts`, `src/domain/auth/roles.ts`.

- Tables: `dashboard_users` (id, email unique lower-cased, display name, role `admin|operator|viewer`,
  `password_hash` scrypt with per-user salt and parameters stored, enabled, created/updated, last
  login) and `dashboard_sessions` (id, user id, `token_hash` SHA-256 of a 256-bit random token,
  created, expires, last seen, revoked). Never the raw token, never the password.
- `POST /v1/auth/login` (email + password → sets an `HttpOnly; Secure; SameSite=Strict; Path=/`
  session cookie, rate-limited per IP tighter than the global limit, constant-time on unknown user),
  `POST /v1/auth/logout`, `GET /v1/auth/me` (user + role + permissions). `GET/POST/PATCH
/v1/admin/users` for admins: create, disable, reset password, change role. Every mutation writes
  an audit event with actor = user.
- The authentication hook accepts **either** a Bearer API token (unchanged) **or** the session cookie;
  a cookie-authenticated request must also carry a same-origin custom header (`X-ChainBank-Session:
1`), which is the CSRF gate given `SameSite=Strict`. The resulting `AuthenticatedActor` carries the
  same `Role` the routes already authorise on (`admin → operator` permissions plus `user:manage`;
  `operator → operator`; `viewer → read-only`), so no route changes.
- Sessions expire after 12 h idle and 7 d absolute; both configurable, defaults in schema.
- Bootstrap: `scripts/create-dashboard-user.ts --email … --role admin` prompts for the password on
  stdin, refuses weak input (length ≥ 12), and prints nothing secret.
- Acceptance: integration tests prove login sets only a hashed row, a wrong password and an unknown
  user take the same code path, a revoked or expired session is denied, a cookie request without the
  header is denied, a Bearer request still works, and a viewer cannot reach an admin route.

### T10.2 🟢 Dashboard shell: sidebar layout, pages, design tokens, collapsible detail — **C32** `[none]`

**Status 2026-09-22: ✅ reviewed and approved in
[#133](https://github.com/StephenForte/ChainBank/pull/133); operator merges.** Composition-only
refactor confirmed by fingerprint (App.tsx keeps 24 state hooks / 6 effects / 88 API call sites) and by
the three pre-existing dashboard tests passing with only an import path changed. The predicted
`DECISIONS.md` tail conflict with T10.1 happened; the planner pushed merge commit `24be952` keeping
C31 before C32. Gate on the merged tree: 668 unit / 52 dashboard / 138 integration. Planner's own
visual check from a scratch dev server: sidebar + purple active item at 1280 px; top-nav collapse and
zero horizontal scroll at 800 px; eight nav items in order. **Convention from this review, for every
later brief:** screenshots go in the PR body, not the repository — this PR committed 16 PNGs (770 KiB)
under `dashboard/screenshots/`, which the operator may keep or drop.

Owns: everything under `dashboard/src/` **except** `dashboard/src/api.ts` (additive only, T10.3/T10.4/T10.6
add calls) and `dashboard/src/panels/*` internals (moved, not rewritten). Owns `dashboard/src/styles.css`.
**Strict no-behaviour-change refactor**: every existing dashboard test passes unmodified except for
imports.

- Split `App.tsx` (1 128 lines) into a shell (`Sidebar`, `TopBar`, `Page`) and one page module per
  nav item: Overview, Treasuries, Wallets, Funding, Reconciliation, Alerts, Email (placeholder), Admin
  (placeholder). Hash routing in-house (`#/treasuries`), no dependency.
- Design tokens as CSS custom properties at `:root` (page bg, card, accent, text, muted, success,
  warning, danger, radius, shadow) and the sidebar/stat-card/table/pill primitives, per the reference
  above. Dark mode is out of scope.
- `CollapsibleSection` becomes the one +/− primitive and is applied to every detail block that is
  not C20-protected: thresholds, policy detail, run detail, acknowledged findings, disabled entities.
- The session panel (pasted token) stays functional in this task; T10.3 removes it.
- Acceptance: dashboard tests green unmodified; a screenshot of each page at 1280 px wide in the PR;
  no `any`; no new dependency.

### T10.3 🟢 Login page, session wiring, Admin page — **C33** `[T10.1, T10.2]`

**Status 2026-09-22: ✅ reviewed and approved in
[#141](https://github.com/StephenForte/ChainBank/pull/141); operator merges.** Run 🔴 in practice, and
sequenced before T10.4 because both rewrite `App.tsx`, `shell.tsx` and `api.ts` (the plan's "parallel"
was wrong; corrected at dispatch). Planner verification: scratch-clone gate 687 unit / 59 dashboard /
143 integration, bundle greps `Authorization` 0 and `operatorToken` 0; probes: every fetch after sign-in
carries the session header and same-origin credentials with no Authorization; only `/v1/auth/me` is
fetched while the session is unknown; per-role button inventory (viewer has no Check now / Test email
/ Acknowledge, no Admin link); the change-password 401 exception holds. Bugbot's stale-401 finding was
fixed with a session epoch and a test. **Operator action after merge:** `npm run user:create` against
the hosted database for the first admin (docs/runbooks/create-dashboard-user.md).

Owns: `dashboard/src/pages/{login,admin}*.tsx` (new), `dashboard/src/session/*` (new); additive on
`dashboard/src/api.ts`, `dashboard/src/App.tsx` (route table).

- Unauthenticated load shows the login page only; `GET /v1/auth/me` decides. All API calls send the
  cookie plus the `X-ChainBank-Session: 1` header; the Bearer path and the paste-a-token UI are
  **removed** from the dashboard (D24). The user block in the sidebar shows name, role, Log out.
- Admin page (admin role only; hidden from others): users table (create, disable, reset password,
  change role) and API credentials (list, issue, revoke — the existing `/v1/admin/credentials`
  routes; the issued token is shown once and never stored client-side). Own-account section for
  every role: change password.
- Acceptance: dashboard tests for the auth gate and the admin visibility rule; an integration test
  that drives login → me → a treasuries read → logout with the cookie only.

### T10.4 🟢 Chain filter and compact overview — **C34** `[T10.2]` (parallel with T10.3)

Owns: `dashboard/src/chain-filter.tsx` (new), `dashboard/src/pages/overview.tsx`, the panel bodies
for treasuries, wallets, funding history and reconciliation (filter plumbing only).

- A segmented control in the top bar: `ALL` plus one segment per registered chain (from the
  treasuries response's `chain.displayName`, de-duplicated by `chainId`); persisted in
  `localStorage`; applied to treasuries, wallets, funding history, reconciliation chain outcomes and
  alerts. C20 rule: a chain with an unacknowledged critical finding shows a badge on its segment even
  when another chain is selected, and the Alerts page ignores the filter for critical items.
- Overview page: stat cards (treasury health per chain, wallets needing attention, open alerts, last
  reconciler run), each linking to its page; treasury cards half their current height with
  thresholds and last-checked behind +/−.
- Acceptance: dashboard tests for filter derivation from N chains, persistence, and the C20 badge rule.

### T10.5 🔴 Email deliveries log and triggers API — **C35**, migration **0012** `[T10.1 merged first, for the migration number]`

**Status 2026-09-22: ✅ approved in
[#137](https://github.com/StephenForte/ChainBank/pull/137) at `381dfee` after one round; operator merges.**
Round one was changes-requested for one blocking defect, fix proven in the planner's clone and
adopted verbatim by the worker, plus a total Resend sender and a regression test; re-review gate
677 unit / 52 dashboard / 140 integration, and the failing provider shape passes through the real
sender for all four bodies. Original finding: The decorator evaluated the delivery row outside its own guard, and the
pre-existing Resend sender returns `reason: undefined` on a 5xx whose body lacks `name`, so a handled
`failed` result became a thrown `TypeError` on the alert path — the trap the brief named. Everything
else verified: scratch-clone gate 676 unit / 52 dashboard / 140 integration; 0012 proven forward on
a populated 0011 database (rows intact, 12 → 13 migrations); ordering, rejecting-repository and
API-key probes held. Approval follows the fix push. **Also found:** T10.2's worker reported its
worktree deleted, but `.claude/worktrees/t10.2` (37 MB, mostly node_modules) is still on disk in the
main checkout; it is git-excluded and unregistered, and breaks local `npm run lint` for anyone
working there. Operator removes it.

Owns: `src/infrastructure/email/recording-email-sender.ts` (new), `src/infrastructure/db/repositories/email-delivery-repository.ts`
(new), `src/app/email/list-email-deliveries.ts`, `src/app/email/describe-email-triggers.ts` (new),
`src/api/routes/admin-email.ts` (new), tests. Additive on `schema.ts`, `ports.ts`, `container.ts`, `app.ts`.

- Table `email_deliveries`: id, sent at, kind (the template name), recipients (text[]), subject,
  status `sent|failed`, provider message id, error summary (rendered with `describeErrorChain`, so
  no provider secret), related entity type/id, correlation id. Written by an `EmailSender` decorator
  that wraps whichever sender the container builds, so every service that sends records the same way.
- `GET /v1/admin/email/deliveries?limit&cursor&status&kind` (operator + read-only), newest first.
- `GET /v1/admin/email/triggers`: the derived, read-only list of what can send mail today and to
  whom — per treasury (chain, kind, warning/critical/recovery/reserve thresholds), reconciliation
  failure threshold, unresolved-alert reminder interval, critical findings, test email — with the
  configured operator recipients. Read from config and treasury rows; no new storage.
- Acceptance: unit tests on the decorator (sent and failed both recorded; a recording failure never
  masks a send result), integration on the two routes; the migration proven forward on populated data.

### T10.6 🟢 Email page — **C36** `[T10.2, T10.5]`

Owns: `dashboard/src/pages/email.tsx` (new); additive on `dashboard/src/api.ts`.

- Triggers table (from C35) and deliveries table with status pills, kind filter, and a +/− per row
  for subject and error detail; "Send test email" moves here from the top bar.
- Acceptance: dashboard tests for rendering both lists and the failed-status pill.

## Run order and models

| Order | Task  | Model | Runs with          | Why here                                                      |
| ----- | ----- | ----- | ------------------ | ------------------------------------------------------------- |
| 1     | T10.1 | 🔴    | T10.2 in parallel  | Auth boundary; owns migration 0011; everything UI waits on it |
| 1     | T10.2 | 🟢    | T10.1 in parallel  | Pure dashboard refactor; disjoint files from T10.1            |
| 2     | T10.5 | 🔴    | after T10.1 merges | Migration 0012 follows 0011; backend only, disjoint from UI   |
| 3     | T10.3 | 🟢    | T10.4 in parallel  | Needs the shell and the login API                             |
| 3     | T10.4 | 🟢    | T10.3 in parallel  | Needs the shell only; touches different pages than T10.3      |
| 4     | T10.6 | 🟢    | alone              | Needs the shell and the deliveries API                        |

Where conflicts remain likely anyway: `src/api/app.ts` and `src/container.ts` (T10.1 and T10.5 both
register; additive, resolve by keeping both); `dashboard/src/api.ts` and the route table in
`App.tsx` (T10.3, T10.4, T10.6 all append; keep both); `tasks/DECISIONS.md` at the tail of §2 and §4,
every time.

## Exit criteria (PRD Phase 10) and how each will be evidenced

| Criterion                                                      | Evidence expected                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Operators log in with email + password; no API token is pasted | Hosted dashboard shows the login page; `GET /v1/auth/me` in the browser after login; the token input is gone from the built bundle |
| A second user can be created and can log in                    | Admin page audit event + that user's own session row                                                                               |
| Sidebar layout, compact panels, +/− detail                     | Screenshots in the T10.2/T10.4 PRs and on the hosted instance                                                                      |
| Chain filter ALL / per chain, derived from registered chains   | Segments read `ALL · Ethereum Sepolia · Base Sepolia` on the hosted instance                                                       |
| Email page shows triggers, recipients and a delivery log       | A real delivery row for the daily treasury-monitor email or a test email                                                           |

Phase 10 is exited only with a §20-style evidence pass against the hosted instance, like Phase 4 and
Phase 6.
