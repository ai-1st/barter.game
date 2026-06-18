---
title: For Developers
---

## Build your own implementation

The barter.game protocol is intentionally small. You can read the full contract in an afternoon. The reference implementation is TypeScript + Deno Deploy, but **the protocol does not care what language or stack you use**.

## The invariant contract

**Read [`PROTOCOL.md`](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md) first.** It defines:

- The document types: Voucher, Account, Account, Tx, Signature, Subscription, Order, Address — plus bank-minted LedgerRecords identified by ULID
- RFC 8785 canonical JSON (cross-runtime parity is load-bearing)
- ed25519 signatures over SHA-256 hashes
- The JSON-RPC envelope and replay protection
- Direct approval: per-holder Txs (`lead`/`follow`), per-record bank approvals, self-advancing banks with a lead-first settle cascade
- The state machine (created → approved → held → settled / rejected)
- The concurrency invariants (sum-to-zero, one active hold per account)

Everything in that file is the contract. Change it and you are no longer speaking barter.game v1.

## What you CAN change

| Layer | Reference choice | Your choice |
|---|---|---|
| Language | TypeScript | Rust, Go, Python, Zig, whatever |
| Runtime | Deno (Deno Deploy) | Node, Bun, Rust Axum, Go net/http, Python FastAPI |
| Database | Deno KV | SQLite, Postgres, CockroachDB, DynamoDB, custom WAL |
| Client | CLI | Web UI, mobile app, Telegram bot, AI agent loop |
| Key storage | Plaintext JSON | Encrypted keystore, hardware wallet, OS keychain |
| Inbox | 10s polling | WebSocket, SSE, push, email |
| Hosting | Deno Deploy | VPS, Fly, Cloudflare, home server |

See [`IMPLEMENTATION.md`](https://github.com/ai-1st/barter.game/blob/main/IMPLEMENTATION.md) for how the reference team made each choice and what alternatives you might consider.

## Quickstart checklist

If you're building a bank from scratch:

1. [ ] Implement RFC 8785 canonical JSON. Verify cross-runtime parity.
2. [ ] Implement ed25519 sign/verify and SHA-256. Use audited libraries.
3. [ ] Define the doc types and their validators.
4. [ ] Build the JSON-RPC envelope handler with replay protection.
5. [ ] Implement `mint`, `create_records`, `submit_tx`, `subscribe`, `notify_signatures`, `reject_deal`, `get_deal`.
6. [ ] Implement the advance engine: legs self-advance created → approved → held → settled, evaluated on every incoming signature.
7. [ ] Enforce **sum-to-zero** on every settle.
8. [ ] Enforce **at most one active hold per account**.
9. [ ] Expose `GET /<name>/barter-bank.json` (and `/<name>/address` if you want an address directory).
10. [ ] Write a client that can run a trade end-to-end (mint → invite → trade → accept), bilateral or N-party.
11. [ ] Run it against the reference banks to verify interop.

## The protocol library

The reference `packages/protocol/` is MIT-licensed and dependency-light. It runs under Bun, Deno, and browser. You can import it directly or treat it as the spec to port:

| File | What to port |
|---|---|
| `canonical.ts` | RFC 8785 canonicalizer. **Must be byte-identical.** |
| `crypto.ts` | ed25519 + SHA-256 + base58. Thin wrappers; easy to replicate. |
| `schemas.ts` | Doc validators. Replicate in your type system of choice. |
| `invite.ts` | `barter://` invite and `barterdeal:` deal-token encode/decode. |
| `deal.ts` | Deal-graph builder: given transfers, compute per-holder Txs, lead/follow roles, predecessors. |

## Read more

- [Invariant protocol contract →](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md)
- [Implementation guide →](https://github.com/ai-1st/barter.game/blob/main/IMPLEMENTATION.md)
- [Database schema →](https://github.com/ai-1st/barter.game/blob/main/SCHEMA.md)
- [Source code →](https://github.com/ai-1st/barter.game/tree/main/packages/protocol)
