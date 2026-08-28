# Rotate the Private (operational) treasury key

**Use this when:** you need a new signing key for the Private working-capital
treasury. Humans still refill the Public address (`TREASURY_ADDRESS`).

**Do not use this for:** rotating the Public refill address — use
[`rotate-treasury-key.md`](./rotate-treasury-key.md).

## Preconditions

- Operator access to Render env for `chainbank-web` and `chainbank-wallet-reconciler`.
- A disposable new keypair. Never commit it.

## Steps

1. Generate a new keypair offline. Record the address and `0x`-prefixed private key.

2. Disable the current operational treasury (`PATCH /v1/treasuries/:id` `{ "enabled": false }`)
   so C23 cannot bind two enabled operational rows.

3. Set on web + wallet-reconciler (and address/thresholds on treasury-monitor, no key):

   - `TREASURY_OPERATIONAL_ADDRESS`
   - `TREASURY_OPERATIONAL_PRIVATE_KEY`
   - operational threshold and policy ETH amounts

4. Redeploy signing-capable services. Boot upserts the new operational row.

5. Confirm `GET /v1/treasuries` shows one enabled Public and one enabled Private.

6. Replenish Private (`POST /v1/treasuries/:id/replenish`) before relying on wallet funding.
