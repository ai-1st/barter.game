---
title: Building a Bank
---

This page is a practical companion to the protocol contract. It walks through the decisions you need to make when building a barter.game bank from scratch.

## 1. Choose your stack

The protocol only requires:
- ed25519 sign/verify
- SHA-256
- RFC 8785 canonical JSON
- An HTTP server that can hold a private key
- Storage that enforces two invariants: sum-to-zero and one-active-hold-per-account

Everything else is up to you.

## 2. Implement canonical JSON first

This is the most dangerous piece to get wrong. If your canonicalizer produces different bytes than the reference implementation, every signature becomes unverifiable across implementations.

**Golden rule:** Sort object keys by Unicode code-unit order. Serialize numbers via ECMAScript `ToString(Number)`. Escape `"`, `\`, and control characters. Drop `undefined` keys.

**Test:** Canonicalize the same document under your runtime and under Bun/Deno. Assert the hashes match. The reference repo has golden vectors you can copy.

## 3. Set up your key model

A bank is an ed25519 keypair. The private key must be:
- Loaded at startup.
- Never exposed to clients.
- Used to sign all RPC responses and `.well-known/barter-bank.json`.

The pubkey is the bank's identity. Every RPC envelope has a `to` field that must match this pubkey; reject if it doesn't.

## 4. Build the RPC envelope

All requests are `POST /rpc` with this shape:

```json
{
  "jsonrpc": "2.0",
  "id": "<ulid>",
  "method": "<name>",
  "params": { ... },
  "pubkey": "<sender>",
  "to": "<your-bank-pubkey>",
  "sig": "<base58-sig>"
}
```

Before dispatching to a method handler:
1. Verify the envelope is well-formed.
2. Verify `to` matches your bank pubkey.
3. Verify `sig` is a valid ed25519 signature over `canonical(envelope minus sig)`.
4. Verify `id` has not been seen before (replay window).
5. Only then, call the method handler.

## 5. Implement the method handlers

Start with read-only methods (`get_promise`, `get_account_balance`, `list_accounts`) — they're simple and let you test your envelope.

Then implement the trade path in order:

### `mint_promise`
- Store the signed Promise doc.
- Auto-create the issuer's Account (negative-balance row).
- Auto-create a Pocket if the user doesn't have one.
- Sign and return a bank attestation.

### `open_account`
- Store the holder-signed Account doc.
- Store the Pocket if supplied.
- This is how a holder prepares to receive a Promise.

### `propose_leg`
- Validate the Tx and **only the records this bank issues**.
- Persist the Tx hash list and the bank's slice.
- Record `role` (lead/follow) and `predecessors`.
- Sign and return `approve`.

### `hold_leg`
- Acquire holds on debit accounts in this bank's slice.
- Return `-32003` on conflict.
- Sign and return `hold`.

### `confirm_receipt`
- Store the holder's settle-action Signature.
- Advance to `confirmed` once **every holder in this bank's own records** has signed.

### `settle_leg`
- Verify leg is `confirmed`.
- Verify every predecessor's `settle` signature is present and valid.
- Apply balance deltas (enforcing sum-to-zero).
- Release holds.
- Sign and return `settle`, with `seen` = upstream signatures.

### `reject_leg`
- Release holds.
- Mark leg `rejected`.

## 6. Enforce the invariants

### Sum-to-zero
On every `settle_leg`, after applying deltas, the sum of `balance` across all accounts for the settled Promise must equal zero (or `+limit`/`-limit` if a limit is set). If it doesn't, your implementation has a bug.

### One active hold per account
When `hold_leg` runs, attempt to acquire a hold. If another active hold exists on the same account, reject with `-32003`. Release holds on `settle`, `reject`, and sweeper cleanup.

## 7. Expose discovery

Implement `GET /.well-known/barter-bank.json`:

```json
{
  "pubkey": "<base58>",
  "url": "<canonical-rpc-url>",
  "name": "my-bank",
  "protocol_version": "barter.game/v1"
}
```

Sign this response with your bank key so clients can verify it.

## 8. Write a client and test end-to-end

You need a client that can:
1. Build a deal graph from transfers.
2. Slice per bank.
3. Call `propose_leg` → `hold_leg` on all banks.
4. Gather `confirm_receipt` from all holders.
5. Call `settle_leg` in topological order (leads first, then followers).
6. Handle `-32003` by calling `reject_leg` everywhere.

Test against the reference banks. If your client can trade with `bank-alice` and `bank-bob`, your implementation is interoperable.

## 9. Production considerations

- **Backup your bank private key.** Lose it and every Promise issued by that bank becomes unverifiable.
- **Rate-limit your RPC endpoint.** Signed RPCs are cheap to verify but expensive to handle.
- **Monitor the sum invariant.** Alert if it ever drifts — it should be impossible, but bugs happen.
- **Decide on a sweeper.** Stuck holds happen. A cron job that releases holds older than N hours is pragmatic.

## Reference file map

| Concern | Path in reference repo |
|---|---|
| Canonical JSON | `packages/protocol/src/canonical.ts` |
| Crypto primitives | `packages/protocol/src/crypto.ts` |
| Doc schemas + validators | `packages/protocol/src/schemas.ts` |
| Invite format | `packages/protocol/src/invite.ts` |
| RPC envelope handler | `supabase/functions/_shared/bank/rpc.ts` |
| Per-method handlers | `supabase/functions/_shared/bank/handlers/*.ts` |
| Database queries | `supabase/functions/_shared/bank/db.ts` |
| Bank bootstrap | `supabase/functions/_shared/bank/server.ts` |
| Method registry | `supabase/functions/_shared/bank/registry.ts` |
| CLI client wrapper | `apps/cli/src/client.ts` |
| Schema migrations | `supabase/migrations/*.sql` |
