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
- Used to sign all RPC responses and `/<name>/barter-bank.json`.

The pubkey is the bank's identity. Every RPC envelope has a `to` field that must match this pubkey; reject if it doesn't.

## 4. Build the RPC envelope

All requests are `POST /<name>/rpc` with this shape:

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

Start with read-only methods (`get_voucher`, `get_account_balance`, `list_accounts`, `get_deal`) — they're simple and let you test your envelope.

One rule that applies everywhere: there is no `open_account`. Accounts are **implicit** — any mutating call can carry Voucher and Account docs, and the bank stores them on first sight (a Voucher must reference this bank; an Account's voucher must be issued here). **Never accept a Pocket body** — `account.pocket` is an opaque hash; Pocket bodies stay with the holder.

Then implement the trade path in order:

### `mint`
- Validate: the Voucher references this bank and is signed by the sender; the two Account docs belong to the sender, reference the Voucher, and sit on **distinct Pocket hashes**.
- The mint is the first ledger record pair: a debit on the issue account (goes negative) and a credit on the holding account (goes positive). Set `pair` on each record.
- Single signer, single bank — settle immediately: apply the deltas, issue per-record `approve` signatures, a `settle` for the mint deal, and a bank attestation over the Voucher hash.

### `create_records`
- Run doc intake first, so new accounts can be referenced in the same call.
- Per transfer: both accounts on the same Voucher, Voucher issued here, integer/positive checks.
- The bank mints debit/credit record pairs with its own ULIDs; `pair` links the two halves.
- Store the leg topology under the deal: `role` (lead/follow), `predecessors`, the full bank list. State: `created`.
- Store in `ledger_records` and return the bodies to the client.

### `submit_tx`
- Params: a holder's Tx plus their `lead`/`follow` signature over its hash. The envelope sender may differ from the holder — anyone can relay a signed Tx.
- Validate: the signature verifies; every record this bank owns in `tx.records` sits on an account whose holder is `tx.pubkey`. Idempotent re-submits are fine.
- Persist the Tx, bind the records to it.
- Per owned record, run the limit/balance check and issue a per-record `approve` or `reject` Signature.
- Leg advances to `approved` once **every** record this bank owns under the deal is Tx-bound and approved.
- Fan out the new signatures, then run the advance engine.

### `subscribe`
- Store the Subscription doc (subscriber pubkey = sender) plus one watch row per key (`record`, `hash`, or `deal`).
- On every signature the bank creates, POST a bank-signed `notify_signatures` envelope to matching subscribers. Fire-and-forget: a lost push is unstuck by client relay.

### `notify_signatures`
- Verify the envelope and each pushed signature (known pubkey, valid sig), store them, then run the advance engine.
- This single method serves both topologies: bank-to-bank push and client relay.

### The advance engine (not an RPC)
Banks self-advance — there is no client hold or settle call. After every `submit_tx` and `notify_signatures`, evaluate the leg:
- `approved` → acquire holds on owned debit accounts, sign `hold` for the deal, fan out, state → `held`. On hold conflict, leave state unchanged; the next event retries.
- `held` → settle. **Lead leg:** once valid `hold` signatures from every other bank in the deal have arrived. **Follow leg:** once valid `settle` signatures from all predecessors have arrived, citing their hashes in `Signature.seen`.
- Settle = apply deltas (enforcing sum-to-zero), release holds, sign `settle`, fan out, state → `settled`. Idempotent.

### `reject_deal`
- Any deal participant can cancel before settlement.
- Release holds, mark the leg `rejected`, fan out the reject signature.

## 6. Enforce the invariants

### Sum-to-zero
On every settle, after applying deltas, the sum of `balance` across all accounts for the settled Voucher must equal zero. If it doesn't, your implementation has a bug.

### One active hold per account
When the advance engine acquires holds, check for another active hold on the same account. On conflict, leave the leg state unchanged — the next incoming signature retries. Release holds on `settle`, `reject`, and sweeper cleanup.

## 7. Expose discovery

Implement `GET /<name>/barter-bank.json`:

```json
{
  "pubkey": "<base58>",
  "url": "<canonical-rpc-url>",
  "name": "my-bank",
  "protocol_version": "barter.game/v1"
}
```

Sign this response with your bank key so clients can verify it.

## 8. Add an address directory (optional but recommended)

The reference server exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/<name>/address/<pubkey>` | Look up a stored Address doc |
| `POST` | `/<name>/address` | Submit or update an Address doc |

Address docs map a pubkey to a human-readable name and a push-receipt URL. They live outside RPC so the mapping itself is not part of a signed RPC envelope.

## 9. Write a client and test end-to-end

You need a client that can:
1. Mint (`mint`: Voucher + two Accounts on distinct Pocket hashes).
2. Produce and consume `barter://` invite strings.
3. Initiate a trade: call `create_records` on each bank, build one Tx per holder, sign yours as `lead`, `submit_tx`, register Subscriptions, and print a `barterdeal:` token per counterparty.
4. Accept: verify a deal token against the banks via `get_deal`, sign your Tx as `follow`, `submit_tx`.
5. Watch the banks self-advance (`get_deal` polling — `barter status`) and relay missing signatures via `notify_signatures` when a push got lost (`barter nudge`).

Test against the reference banks: mint → invite → trade → accept → status. If your client can trade with `bank-alice` and `bank-bob`, your implementation is interoperable.

## 10. Production considerations

- **Backup your bank private key.** Lose it and every Voucher issued by that bank becomes unverifiable.
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
| Deno Deploy entrypoint | `apps/bank/main.ts` |
| Env var key loader | `apps/bank/env.ts` |
| RPC envelope handler | `apps/bank/rpc.ts` |
| Per-method handlers | `apps/bank/handlers/*.ts` |
| Deno KV database layer | `apps/bank/db.ts` |
| Bank method registry | `apps/bank/registry.ts` |
| Advance engine | `apps/bank/advance.ts` |
| Signature fan-out | `apps/bank/subscriptions.ts` |
| CLI client wrapper | `apps/cli/src/client.ts` |
