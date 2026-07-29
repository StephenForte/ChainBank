# PRD: Postgres TLS Leaf Pinning Hardening

**Status:** Ready for implementation  
**Related:** Hosted Render Postgres TLS (`DATABASE_SSL_CA`), Phase 0 deploy runbook  
**Risk class:** High (network access, production database trust, security)  
**Success proof:** Unit tests / local CI only (no required live Render verification in this PRD)

## 1. Introduction / Overview

Hosted ChainBank enables Postgres TLS with `rejectUnauthorized: true` and a configured `DATABASE_SSL_CA`. Comments and the deploy runbook claim **certificate pinning**, including leaf fingerprint matching via a custom `checkServerIdentity`.

That custom checker currently **never rejects** a fingerprint mismatch: both match and mismatch paths return success (`undefined`). Hostname verification is also skipped. For Render’s usual self-signed leaf-as-CA setup, OpenSSL chain verification against the pinned PEM still provides real protection, but the identity helper overclaims and will mislead future changes.

This PRD covers the full follow-up from the risk review:

1. Make leaf pinning real (reject on mismatch).
2. Keep hosted TLS fail-closed without a CA.
3. Close the negative unit-test gap.
4. Clarify pin mode at startup (log/assert).
5. Update the deploy runbook with checklist + cert-rotation steps.

Primary goals: **close the P1 identity defect** and **make hosted DB TLS trustworthy enough to treat as done for Phase 0 merge confidence**, proven by unit tests.

## 2. Goals

- Enforce **leaf-only pinning**: peer certificate fingerprint256 must equal the fingerprint of `DATABASE_SSL_CA`; otherwise reject the TLS handshake identity check.
- Remove or rewrite any code path that accepts a non-matching peer after chain verification.
- Preserve fail-closed behavior: TLS on ⇒ `DATABASE_SSL_CA` required; never disable verification.
- Add unit tests that fail if mismatch acceptance regresses.
- Log (or assert) a clear pin mode so operators and logs do not imply hostname verification.
- Document deploy checklist and cert-rotation steps in the Render Phase 0 runbook.
- Keep changes minimal and coherent with `AGENTS.md` security invariants (no secrets in logs).

## 3. User Stories

### US-001: Enforce leaf fingerprint match in `checkServerIdentity`

**Description:** As a security-conscious operator, I want the database TLS identity check to reject any peer whose certificate fingerprint does not match `DATABASE_SSL_CA`, so that “leaf pinning” is actually enforced.

**Acceptance Criteria:**

- [ ] `createPinnedCaCheckServerIdentity` returns `undefined` only when `peerCert.raw` fingerprint256 equals the pinned PEM’s fingerprint256
- [ ] Fingerprint mismatch returns an `Error` (handshake identity failure)
- [ ] Missing `peerCert.raw` still returns an `Error`
- [ ] Hostname is not used as an accept condition (leaf pin is the sole identity rule)
- [ ] No issuing-CA “accept any chained leaf” fallthrough remains
- [ ] Comments in `src/infrastructure/db/client.ts` match the leaf-only behavior
- [ ] Typecheck / lint / unit tests pass

### US-002: Negative unit tests for identity rejection

**Description:** As a developer, I want unit tests that assert mismatch rejection so the prior accept-on-mismatch bug cannot return unnoticed.

**Acceptance Criteria:**

- [ ] Test: peer raw cert matching the pinned sample CA → `checkServerIdentity` returns `undefined`
- [ ] Test: peer raw cert from a **different** generated disposable cert → returns `Error`
- [ ] Test: peer with `raw === undefined` → returns `Error`
- [ ] Tests use generated disposable keys/certs only (no real provider secrets)
- [ ] Existing PEM normalization / `buildSslOptions` fail-closed tests remain green
- [ ] Typecheck / unit tests pass

### US-003: Startup / buildSsl pin-mode clarity

**Description:** As an operator reading logs or reviewing config, I want an explicit leaf-pin mode signal so I do not assume hostname verification is active.

**Acceptance Criteria:**

- [ ] When TLS is enabled, pin mode is determined as `leaf` (this PRD does not ship a separate CA mode)
- [ ] Safe diagnostic is available without logging the PEM (e.g. log field `databaseTlsPinMode: 'leaf'` and/or CA fingerprint256 only — never the full certificate or `DATABASE_URL` password)
- [ ] At minimum: migration probe / config-loaded path or pool construction documents pin mode in structured logs already used by migrate/web startup — pick the smallest existing log site
- [ ] Invalid PEM still fails at `buildSslOptions` / config validation before use
- [ ] Typecheck / unit tests pass for any new pure helpers

### US-004: Runbook deploy checklist and cert rotation

**Description:** As an operator deploying on Render, I want a short checklist and rotation steps so a cert change or missing env var does not become an unexplained outage.

**Acceptance Criteria:**

- [ ] `docs/runbooks/deploy-render-phase0.md` states leaf-only pinning: peer fingerprint must equal `DATABASE_SSL_CA`
- [ ] Deploy checklist includes: `DATABASE_SSL_CA` on **web and cron**; no `NODE_TLS_REJECT_UNAUTHORIZED=0`; funding remains disabled for Phase 0
- [ ] Cert-rotation section: re-run `node scripts/print-database-ca.mjs` in Render web Shell → paste escaped one-liner → redeploy web + cron → confirm migrate/`select 1` path
- [ ] Remove or correct any wording that implies issuing-CA mode or hostname skip-as-trust
- [ ] Bootstrap script note: run only from Render web Shell (untrusted networks can poison the pin)

## 4. Functional Requirements

- **FR-1:** When `useSsl` is true, `buildSslOptions` must require a non-empty `sslCertificateAuthority`, normalize PEM, parse it as X.509, and set `rejectUnauthorized: true`.
- **FR-2:** `checkServerIdentity(hostname, peerCert)` must ignore hostname for acceptance and require `fingerprint256(peerCert.raw) === fingerprint256(pinnedCaPem)`.
- **FR-3:** On fingerprint mismatch or missing peer raw bytes, `checkServerIdentity` must return an `Error` (not `undefined`).
- **FR-4:** There must be no code path that accepts a peer solely because chain verification already succeeded under an issuing CA.
- **FR-5:** Unit tests must cover accept (same cert) and reject (different cert, missing raw).
- **FR-6:** Structured diagnostics may include `databaseTlsPinMode: 'leaf'` and optionally the CA fingerprint256; must not include PEM body, private keys, or full `DATABASE_URL`.
- **FR-7:** Hosted config and migrate config must continue to throw `INVALID_CONFIGURATION` when TLS is enabled and `DATABASE_SSL_CA` is missing/blank.
- **FR-8:** Runbook must document leaf pin semantics, deploy checklist, and rotation procedure.

## 5. Non-Goals (Out of Scope)

- Issuing-CA trust mode (chain-to-CA without leaf fingerprint match)
- Restoring Node default hostname / SAN verification against `dpg-…` hosts
- Feature flags, shadow mode, or dual-path TLS
- Live / opt-in integration tests against real Render Postgres (success proof is unit tests only)
- Changing how `DATABASE_SSL_CA` is obtained beyond runbook clarity (script rewrite only if required for leaf-pin docs)
- Disabling TLS verification for any environment
- Mainnet, funding enablement, or signing-path changes
- UI / dashboard changes

## 6. Design Considerations

- No UI. Operator-facing surface is env vars + runbook + structured logs.
- Prefer the smallest change in `src/infrastructure/db/client.ts` over new abstraction layers.
- Reuse existing `normalizePem` / `assertValidPemCertificate` / unit fixture patterns.

## 7. Technical Considerations

- **Why leaf-only:** Render Postgres presents a self-signed leaf whose CN is a UUID while `DATABASE_URL` uses `dpg-…`. node-postgres overwrites TLS `servername` with the TCP host, so default hostname checks fail. Leaf fingerprint pinning is the correct identity substitute for this provider shape.
- **Trust bootstrap:** `scripts/print-database-ca.mjs` uses `openssl s_client` without verification. That is acceptable only on the trusted Render private path; runbook must say so.
- **Rotation:** Leaf pin implies outage until operators update `DATABASE_SSL_CA` after provider cert rotation — document, do not soften pinning to avoid that.
- **Test fixtures:** Generate a second disposable cert in the unit test (or add a second fixture PEM) so mismatch is real, not mocked into false confidence.
- **AGENTS.md:** Never log secrets; never weaken verification to make a test pass; domain must not import infra; keep amounts/`wei` changes out of this work unless already landed separately.

### Implementation sketch (non-normative)

```ts
// Desired behavior in createPinnedCaCheckServerIdentity:
// 1. pinnedFingerprint = X509Certificate(caPem).fingerprint256
// 2. if peerCert.raw missing → Error
// 3. if X509Certificate(peerCert.raw).fingerprint256 !== pinnedFingerprint → Error
// 4. else → undefined (success)
```

Delete the current “issuing-CA pin: return undefined” fallthrough.

## 8. Success Metrics

- P1 defect closed: mismatch cannot succeed in unit tests.
- Hosted TLS story is accurate: code comments, runbook, and behavior all say **leaf pin**.
- CI unit suite covers accept + reject paths; format/lint/typecheck/unit gates remain green.
- No new verify-off escape hatch introduced.
- Operators have a copy-pastable checklist for deploy and cert rotation.

## 9. Open Questions

- Should migrate / web startup log the **CA fingerprint256** in addition to `databaseTlsPinMode: 'leaf'`, or is pin mode alone enough for US-003?
- If Render ever issues a true CA-signed chain instead of a self-signed leaf, do we open a follow-up PRD for CA mode, or keep requiring operators to pin the leaf only?
- Does `print-database-ca.mjs` need a stderr warning when not obviously running on Render, or is runbook-only guidance sufficient?

## 10. Mapping to Review Follow-ups

| Review item                                        | Story / FR                 |
| -------------------------------------------------- | -------------------------- |
| Fix checker: mismatch → Error                      | US-001, FR-2, FR-3         |
| Negative unit test                                 | US-002, FR-5               |
| Startup pin-mode log/assert                        | US-003, FR-6               |
| Deploy checklist + cert rotation                   | US-004, FR-8               |
| Keep fail-closed without CA                        | FR-1, FR-7 (preserve)      |
| No feature flag / sandbox required for merge proof | Success proof = unit tests |
