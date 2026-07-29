# Security Review — T1.5 Funding Dispatch Engine (PR #8)

**Date:** 2026-07-28
**Scope:** `feat/t1.5-funding-dispatch` — the only code path that signs and submits
treasury transfers. Reviewed against AGENTS.md §7 security invariants and PRD §15.2.
**Method:** analysis pass over the full diff plus surrounding context, then one
independent adversarial verification pass per candidate finding.

## Outcome

No injection, secret-exposure, or authorization-bypass issues were found. Verified
sound: parameterized advisory-lock SQL, bigint-only wei math, idempotency committed
before submission with correct unique-violation race handling, chain ID verified
before signing (twice), private key absent from logs and error objects, gas
estimation failing closed, database unavailability preventing signing.

Two findings were confirmed against the repo's own mandated invariants and **fixed
on this branch**. A third was judged not reportable today and converted into a
binding requirement for T1.6.

## Finding 1 — Reserve check used pre-lock balance snapshots (CONFIRMED, fixed)

**Severity:** Medium · **Invariant:** AGENTS.md §7.4, PRD §8.5, P1-US5

The reserve re-check under `pg_advisory_xact_lock` re-ran arithmetic on the
caller-supplied `treasury.balanceWei` captured before lock acquisition. Nothing
re-read the balance or aggregated the treasury's in-flight transfers, and the
repository interface exposed no treasury-scoped query, so the invariant was
unsatisfiable by any caller. Critically, a fresh read would not have fixed it:
`eth_getBalance` reflects only mined state, so a treasury's own submitted-but-unmined
sends are invisible.

_Failure scenario:_ treasury 1.0 ETH, reserve 0.9 ETH. Serial funding of three
different below-minimum wallets within one block window each measured against the
same 1.0 ETH and each submitted ~0.09 ETH, ending ~0.73 ETH — below reserve. The
per-wallet pending gate never fired because each request targeted a different wallet.

**Fix:** `calculateTreasurySpendableWei` now requires `inFlightWei`;
`FundingTransactionRepository.sumInFlightAmountWeiByTreasury` sums `created |
submitted | submission_unknown` amounts for the treasury, and dispatch supplies it
from inside the lock. Regression test asserts that total in-flight never exceeds
balance minus reserve and that the wallet exhausting spendable is blocked.

## Finding 2 — Ambiguous submission outcomes persisted as terminal (CONFIRMED, fixed)

**Severity:** Medium · **Invariant:** AGENTS.md §7.5, PRD "retries never duplicate transfers"

Two paths converted an _unknown_ transaction state into a _terminal_ one:

1. Dispatch caught any `sendNativeTransfer` error and marked the row `failed` with no
   hash. An RPC timeout on `eth_sendRawTransaction` does not mean the transaction was
   not broadcast — and viem's transport retry amplifies this, since the retry of an
   already-broadcast transfer fails with "already known" while the original sits in
   the mempool.
2. The receipt tracker returned terminal `dropped` whenever a non-timeout wait error
   occurred and `getTransaction` failed — which included plain network errors, because
   viem throws `TransactionNotFoundError` rather than returning null, making the
   `null` branch dead code.

Because `findPendingByManagedWallet` counted only `created | submitted`, a terminal
row reopened the per-wallet duplicate gate while ETH could still be in flight, and a
broadcast transfer recorded without a hash was permanently unreconcilable.

**Fix:**

- New non-terminal status `submission_unknown` (migration `0003`, additive `ALTER TYPE`;
  verified applying both to a fresh database and forward from `0002`). It counts as
  in-flight for the duplicate gate and the reserve, and retains the nonce.
- Only `PRE_BROADCAST_ERROR_CODES` (signer unavailable, chain mismatch, gas estimation,
  amount/address/request validation, disabled gates) produce a terminal `failed`;
  everything else — including unrecognized codes — is treated as possibly-broadcast.
- `TransactionReceiptTracker.waitForOutcome` now requires `senderAddress` and `nonce`.
  An unknown hash yields `replaced` only when the account nonce has advanced past the
  transaction's nonce (proof it can never mine); otherwise `pending`. Probe failures
  yield `pending`. Transient RPC errors can no longer manufacture a terminal state.

Note: the pre-existing unit test asserting `RPC_UNAVAILABLE ⇒ failed` encoded the
defective behavior and was rewritten to assert the corrected semantics.

## Observation 3 — Destination allowlist enforced only by contract comment (deferred)

**Verdict:** not reportable today (no untrusted caller exists) · **Action:** binding T1.6 requirement

`dispatchFunding` sends to the caller-supplied `wallet.address`, and never checks it
against the address registered for `wallet.id`; `TreasurySigner` explicitly delegates
allowlisting to its caller. This is a documented, deliberate trust boundary, and the
only callers today are tests. Every reachable path still enforces the fail-closed
stack (kill switch, enable flags, chain ID, reserve, pending gate).

**Requirement for T1.6:** the `ensure-funded` endpoint must derive the destination
exclusively from `ManagedWalletRepository.findById(walletId)` — verifying the row
exists, is `enabled`, and matches the treasury's chain — never from request input,
with an explicit test rejecting an arbitrary caller-supplied address (AGENTS.md §7.1).
Preferred hardening: change the dispatch input contract to accept only `wallet.id`
and resolve the address internally, removing the id/address pair that permits divergence.

## Follow-up work created

| Item                                                                                  | Owner task |
| ------------------------------------------------------------------------------------- | ---------- |
| Endpoint must resolve destination from the DB, never request input                    | T1.6       |
| Reconciliation must resolve `submission_unknown` rows by searching the recorded nonce | T4.x       |
| Consider persisting the transaction hash before broadcast (sign-then-send-raw)        | T4.x       |
