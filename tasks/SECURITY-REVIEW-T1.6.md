# Security Review — T1.6 `POST /v1/wallets/:id/ensure-funded` (PR #13)

**Date:** 2026-07-29
**Scope:** the first HTTP path that can cause a treasury ETH transfer.
**Method:** analysis pass over the diff, then an adversarial pass instructed to
refute the first reviewer's conclusions. Every finding below was independently
verified against the source before being reported.

## Outcome

The binding requirement from the T1.5 review is **met**, and the PR's own work is
sound. But the adversarial pass showed that scoping a review to the diff was the
wrong frame here: this PR converts three latent infrastructure weaknesses into
money-path exposures. All three are fixed on this branch.

## Verified sound (survived adversarial pressure)

- **Destination integrity.** `DispatchFundingInput` no longer carries an address;
  `resolveAllowlistedWallet` is the only source of `to`, re-resolved _inside_ the
  advisory lock (closing the TOCTOU window) with existence, `enabled`, and
  chain-ID re-checked. The route accepts a uuid param and a body of
  `{idempotencyKey}` with `additionalProperties: false`, and ajv runs with
  `removeAdditional: false`, so unknown fields are rejected rather than stripped.
  Proven by a test that posts an `address` field and asserts 400 with zero signer
  calls.
- **Authorization.** `authorizeScope` runs inside the application service using
  project/environment ids from the database row, never the request. The new
  `fund` action does not alter `read`/`mutate` behavior for any role; cron and
  read-only roles are denied; project-service requires a matching scope row.
- **Fresh reads, idempotency scoping per credential, error redaction, and the
  FUNDING_ENABLED / kill-switch gates** all behave as documented, and the T1.5
  invariants (in-flight reserve accounting, `PRE_BROADCAST_ERROR_CODES`,
  nonce-in-lock, chain verify-before-sign) are intact. The modified tests are
  mechanical adaptations to the new contract, not weakenings.

## Finding 1 — Rate limiting on the ETH-spending endpoint never engaged (Medium, fixed)

`keyGenerator` read `request.actor?.credentialId`, but `@fastify/rate-limit`
installs at `onRequest` (its documented default) while `authenticate` is a route
`preHandler`. `onRequest` always precedes `preHandler`, so `request.actor` was
invariably `undefined` and the credential branch was dead code — every limit
silently degraded to per-IP, contradicting PRD §15.3.

The fallback was worse: `trustProxy: config.app.isHosted` is `true` in every
hosted environment, and Fastify with `trustProxy: true` takes the **left-most**
`X-Forwarded-For` entry, which any client can set.

_Failure scenario:_ a scoped project-service credential loops the endpoint with a
fresh idempotency key and a rotating `X-Forwarded-For` per request; the bucket
never collides. Per-burst damage stays bounded by the reserve, but nothing bounds
cumulative spend, and this was the only intended throttle.

**Fix:** the limiter key is now derived from the presented bearer token
(`tok:<sha256>`), which is available at `onRequest` without reordering hooks and
keeps the raw token out of the key store; unauthenticated traffic still falls back
to `ip:`. `trustProxy` is now `TRUSTED_PROXY_HOPS` (default 1, Render's actual hop
count) and never `true`. Six unit tests pin the key derivation.

## Finding 2 — Signing key was never bound to the reserve-enforced treasury (Medium, fixed)

The treasury row's address (`TREASURY_ADDRESS`) and the signing key
(`TREASURY_PRIVATE_KEY`) are independent configuration, and no assertion anywhere
in the tree tied them together. `dispatchUnderLock` verified the chain ID but
never the account identity.

_Failure scenario:_ the two diverge — a rotated key, a staging key in production.
The balance read, the reserve floor, the in-flight accounting, and the nonce probe
then all describe an account that is not spending, so the real treasury can drain
to zero while every gate reports healthy.

**Fix:** `assertSignerMatchesTreasury` refuses to proceed unless
`signer.address` equals the resolved treasury address (case-insensitive: one side
is checksummed, the other normalized). The signer address is deliberately kept out
of the error context. Two unit tests cover the refusal and the non-disclosure.

## Finding 3 — Idempotency keys were not scoped to the wallet (Low, fixed)

The lookup key was `(requestedBy, idempotencyKey)` only. Reusing a key against a
different wallet returned `kind: 'replay'` reporting the _first_ wallet's
`operationId`, `transactionHash`, and `transferredWei` while the second wallet was
never funded — and the caller could not tell.

**Fix:** the stored key is namespaced as `${walletId}:${idempotencyKey}`, so a
reused key against another wallet is a distinct operation. Regression test added.

## Related, fixed by the same change

The audit row for every transfer stored `request.ip`, which by Finding 1's
mechanism was attacker-controlled — the one field on the money path not derived
from server state. The `trustProxy` fix makes it trustworthy.

## Not findings (recorded for completeness)

- **Wallet-existence oracle.** `findById` runs before `authorizeScope`, so an
  out-of-scope wallet yields 404 vs 403 for a nonexistent one. Ids are v4 UUIDs
  with uuid-format validation, so this is not practically enumerable.
- **Partially stale in-lock gates.** Inside the lock, `wallet.enabled` is
  re-checked freshly but `projectEnabled` / `environmentEnabled` / treasury
  `enabled` still come from pre-lock snapshots. The exposure is a sub-second
  window on an admin disable. Hardening, not a vulnerability — a candidate for
  T2.2, which will hold these snapshots longer across many wallets.
