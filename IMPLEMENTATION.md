# barter.game — v1 Reference Implementation Guide

> **This document is NOT the protocol contract.** It describes how *this repository* implements barter.game v1. If you are building your own bank or client, read `PROTOCOL.md` first for the invariant rules you must follow, then read this file for inspiration, file maps, and lessons from our specific choices.
>
> You may change anything in this document for your own implementation. The protocol doesn't care if you use Postgres or SQLite, Bun or Rust, Edge Functions or a VPS. It cares that you enforce the invariants in `PROTOCOL.md` §9.

---

## 1. Overview

The v1 reference implementation consists of:

- **`packages/protocol/`** — a TypeScript library of canonical JSON, crypto primitives, doc schemas, the deal builder, and the invite / deal-token codecs. Shared between the CLI and the server.
- **`apps/cli/`** — the `barter` command-line client. Init, mint, account, invite, trade, deal, accept, status, nudge, subscribe, inbox.
- **`supabase/functions/`** — Supabase Edge Functions that act as bank processes. One function per bank in the demo; the protocol supports arbitrary separation.
- **`supabase/migrations/`** — Postgres schema. One database backs all demo banks; rows are scoped by `bank_pubkey`.

The demo runs four live banks (`bank-alice`, `bank-bob`, `bank-carol`, `bank-dave`) on a single Supabase project. Additional banks can be added by creating a new Edge Function and generating a keypair.

---

## 2. Runtime & toolchain

| Layer | Choice | Rationale |
|---|---|---|
| Server runtime | Deno (via Supabase Edge Functions) | Sandboxed, cold-start friendly, native TypeScript |
| Client runtime | Bun | Fast package install, native TypeScript runner |
| Protocol library | TypeScript, runs under Bun, Deno, and browser | Cross-runtime parity is the load-bearing guarantee |
| Database | Postgres (Supabase managed) | ACID, `NUMERIC` exact arithmetic, partial unique indexes |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all target environments |
| Key storage (user) | `~/.barter/profile.json` on disk | v1 is CLI-first; web UI key storage is a v1.5 concern |
| Key storage (bank) | Supabase Secrets (`BANK_<NAME>_PRIV_KEY`) | Injected as env var at Edge Function cold start |

> **You can change any of these.** The protocol only requires ed25519 signatures, SHA-256, and RFC 8785 canonical JSON. If your stack is Rust + SQLite + WASM, that is a perfectly valid v1 implementation as long as the wire format and invariants match.

---

## 3. The `packages/protocol/` library

This is the most reusable part of the reference implementation. It is dependency-light and environment-agnostic.

| File | Purpose |
|---|---|
| `src/canonical.ts` | Hand-rolled RFC 8785 canonicalizer. Guaranteed byte-identical across Bun, Node, Deno, and browser. |
| `src/crypto.ts` | ed25519 sign/verify, SHA-256, base58 encode/decode. Thin wrappers around `@noble/*`. |
| `src/schemas.ts` | Runtime validators for all doc types (incl. Subscription). Zod-like without the dependency — plain TypeScript predicates. |
| `src/invite.ts` | Encode/decode `barter://` invite strings (with bundled Account bodies) and `barterdeal:` deal tokens — the initiator → follow-holder handoff. |
| `src/deal.ts` | Deal builder: given transfer specs and bank-minted record ULIDs, assemble ONE Tx PER HOLDER (a disjoint exact cover of the records), compute hashes, lead/follow roles, and per-bank predecessors. |
| `src/index.ts` | Re-exports. |

The cross-runtime parity test is the most important test in the repo. It canonicalizes the same document under Bun and Deno and asserts the hashes match. If this test fails, every signature in the protocol is unverifiable across implementations.

**Reusing this code:** The protocol package is MIT-licensed (license file lands with public release). You can import it directly if you are building a TypeScript client or server. If you are building in another language, treat the source as the spec: port the canonicalizer exactly, keep the crypto primitives equivalent, and replicate the schema validators.

---

## 4. Server architecture (banks)

### 4.1 Supabase Edge Functions

Each bank is a Deno entrypoint in `supabase/functions/bank-<name>/index.ts`. At cold start it:

1. Loads its private key from `Deno.env.get("BANK_<NAME>_PRIV_KEY")`.
2. Derives its pubkey and matches it against the `to` field of every incoming RPC envelope.
3. Routes requests through the shared handler registry.

Shared code lives in `supabase/functions/_shared/` and is synced from `packages/protocol/` via `scripts/sync-protocol.ts`:

```bash
bun run scripts/sync-protocol.ts   # copies packages/protocol/src → _shared/protocol/
```

### 4.2 Multi-tenant database

One Postgres database serves all banks in a deployment. Each bank-scoped table carries a `bank_pubkey TEXT NOT NULL` column. Every query filters on it. There is no Row-Level Security in v1 — the Edge Function is the trust boundary, and direct DB access is operator-only.

This was chosen for operational simplicity (one project, one migration set, one backup). True federation would put each bank in its own Supabase project. The protocol supports either; this is a deployment choice.

### 4.3 Handler file map

| File | Purpose |
|---|---|
| `_shared/bank/rpc.ts` | Envelope validation, signature check, replay-window claim, method dispatch |
| `_shared/bank/registry.ts` | Method name → handler function map |
| `_shared/bank/server.ts` | Bank bootstrap: load key, start HTTP listener, attach routing |
| `_shared/bank/db.ts` | Postgres queries: doc insert, balance update, hold acquire/release, deal-leg state, subscriptions, received-signature lookups |
| `_shared/bank/advance.ts` | The advance engine — `advanceDeal()` self-advances a leg through hold and settle (see §4.4) |
| `_shared/bank/subscriptions.ts` | Signature fan-out: POST bank-signed `notify_signatures` envelopes to matching subscribers (fire-and-forget) |
| `_shared/bank/peer.ts` | HTTP client for signed bank-to-bank calls |
| `_shared/bank/handlers/intake.ts` | Shared doc intake — Promise/Account docs attached to any mutating call; accounts come into existence here (Pocket bodies are rejected) |
| `_shared/bank/handlers/mint_promise.ts` | `mint_promise` — the mint as the first record pair on two distinct pockets, settled immediately |
| `_shared/bank/handlers/create_records.ts` | `create_records` — bank mints debit/credit record pairs with ULIDs, stores its slice of the settle topology |
| `_shared/bank/handlers/submit_tx.ts` | `submit_tx` — verify a holder's lead/follow Tx signature, issue per-record `approve`/`reject`, advance the leg |
| `_shared/bank/handlers/subscribe.ts` | `subscribe` — store a Subscription doc + its watch keys |
| `_shared/bank/handlers/notify_signatures.ts` | `notify_signatures` — accept pushed/relayed signatures (from anyone), verify, store, re-advance touched deals |
| `_shared/bank/handlers/reject_deal.ts` | `reject_deal` — participant-initiated cancellation: release holds, mark `rejected`, fan out |
| `_shared/bank/handlers/get_deal.ts` | `get_deal` — leg state + record bodies + deal signatures (token verification, polling, relay) |
| `_shared/bank/handlers/get.ts` | `get_promise`, `get_account_balance`, `list_accounts` — read-only queries |

Removed from the old model: `open_account` (accounts are implicit — `intake.ts`), `propose_leg` and `confirm_receipt` (both subsumed by the holder's own Tx signature in `submit_tx`), and `hold_leg` / `settle_leg` as client RPCs (that logic moved into the advance engine).

### 4.4 The advance engine — banks self-advance, event-driven

There is no client `settle` command and no cron job (Supabase Edge Functions have no background workers). `advanceDeal(deal)` in `advance.ts` runs after every event that can unblock a leg — a `submit_tx` that completes approval, or a signature arriving via `notify_signatures` — and moves the leg as far as it can:

1. **`approved` → `held`**: acquire holds on the owned debit accounts (keyed `(account, deal)`; a conflict backs off quietly and is retried on the next event), sign `{deal, action: "hold"}`, fan out.
2. **`held` → `settled`, lead leg**: settle once valid `hold` signatures from **every other bank in the deal** have been observed. The lead settles first, bearing the lead/follow risk.
3. **`held` → `settled`, follow leg**: settle once verified `{deal, action: "settle"}` signatures from all predecessor banks are stored; their hashes go into this bank's settle `Signature.seen` — the verifiable proof chain.
4. Settle applies the balance deltas for every owned record, releases the holds, signs `settle`, and fans out. Idempotent by state, never by replay.

Blocked conditions return quietly; the next incoming signature retries. Authority never comes from the caller — holds require a fully approved leg, and settles require stored, verified peer signatures.

A hold abandoned by a dead deal currently stays until `reject_deal` releases it; an operator hold-sweeper is a hygiene item on the roadmap (`TODOS.md`), not a correctness mechanism — the protocol has no timeouts.

### 4.5 Replay window implementation

The replay window is stored in the `replay_window` table. The sweeper enforces:

1. Per-sender LRU cap: keep the 100 most recent IDs.
2. Idle TTL: drop anything older than 7 days.

The "whichever set is larger" rule means a sender that sends 200 IDs in an hour keeps 100; a sender that sends 5 IDs over two weeks keeps all 5 (assuming they're within the 7-day window).

These numbers are arbitrary and tuned for the demo. Your implementation may choose different caps.

### 4.6 Subscription fan-out and client relay

Signature delivery is push-based: the initiating client sends Subscription docs to each bank (the CLI cross-subscribes the banks in a deal to each other by default), and each bank POSTs a bank-signed `notify_signatures` JSON-RPC envelope to the subscription's URL whenever it creates a matching signature. Pushes are fire-and-forget with a short timeout — a lost push never fails the originating request.

The recovery path is client relay: `barter nudge` reads every bank's signatures via `get_deal` and delivers them to every other bank via the same `notify_signatures` method. Signatures carry their own authority (signer pubkey + ed25519 sig), so banks accept them from anyone. Clients watching a deal use `barter status` (on-demand `get_deal` polling); there is no WebSocket or SSE in v1 — a client UX choice, not a protocol requirement.

---

## 5. Client architecture (CLI)

### 5.1 Commands

| Command | Purpose |
|---|---|
| `barter init --bank <url>` | Pin a bank URL+pubkey in `~/.barter/profile.json` |
| `barter mint "<name>" --amount N [--integer] [--due YYYY-MM-DD] [--limit N]` | Mint a Promise: builds two Pocket/Account pairs locally, the bank settles the first record pair immediately |
| `barter account <promise-hash> [--name <pocket>]` | Author a receiving Account locally — no bank call; accounts are implicit |
| `barter invite --give <promise>:N --get <promise>:N` | Offer a swap: prints a signed `barter://` string with account hashes + bundled Account bodies |
| `barter trade --invite "<barter://...>"` | Initiate a bilateral swap from an invite: records on both banks, cross-subscriptions, lead Tx, deal token |
| `barter deal <deal-file.json>` | Initiate an N-party deal (any number of banks/holders); prints one deal token per other holder |
| `barter accept "<barterdeal:...>"` | Verify a deal token against the banks (`get_deal`), follow-sign your own Tx, submit |
| `barter status <deal-ulid>` | Watch a deal you initiated (per-bank leg states) |
| `barter nudge <deal-ulid>` | Relay signatures between banks by hand — un-sticks a deal whose pushes were lost |
| `barter subscribe --bank <url> --url <push-url> ...` | Register a standing signature fan-out (manual escape hatch; `trade`/`deal` subscribe for you) |
| `barter inbox [--bank <url>]` | List your accounts (with balances) at a bank |

There is no `confirm` and no `settle`: a holder accepting a deal signs their own Tx (which IS the receipt confirmation), and the banks settle on their own.

### 5.2 Deal orchestration (client-side)

`apps/cli/src/orchestrate.ts` is the initiator's path, split in two:

- `createRecordsAndLead()` — wave 1: `create_records` on every bank, cross-subscribe the banks to each other's deal signatures, sign and submit the initiator's own Tx as `lead`. The client's active role ends here.
- `relayAll()` — the `barter nudge` path: collect every bank's signatures via `get_deal` and deliver them to every other bank via `notify_signatures`.

`makeDealTokens()` encodes one signed `barterdeal:` token per follow holder (their unsigned Tx, the record bodies, the bank URLs), and `submitFollow()` is the `barter accept` half. `apps/cli/src/dealstate.ts` persists the initiator's deal state under `~/.barter/deals/`, keyed by the deal ULID — holder Txs, per-bank legs, record bodies — so `status` and `nudge` work after the fact.

### 5.3 Profile storage and the local doc store

User keys are stored in `~/.barter/profile.json` as raw base58 private keys. There is no encryption, no passphrase, no hardware wallet integration. This is acceptable for a demo and unacceptable for production. v1.5 will add Argon2id or PBKDF2 key encryption.

Client-authored docs live in `~/.barter/docs/`, keyed by content hash (`apps/cli/src/docstore.ts`). Account bodies travel with later requests (invites, deal files, `create_records`/`submit_tx` `docs[]`); **Pocket bodies never leave the machine** — banks only ever see the pocket hash inside an Account doc.

> **Implementation detail:** How you store user keys and docs is entirely up to you. The protocol only sees the pubkey on the wire.

---

## 6. Database schema (v1 reference)

See `SCHEMA.md` for the full schema, table definitions, indexes, triggers, and invariants. A quick summary of the load-bearing choices:

- `base58 TEXT` for all hashes, pubkeys, and signatures. No binary types — easier to debug, portable across languages.
- `NUMERIC` for balances. Exact arithmetic; never floating point.
- `TIMESTAMPTZ` for all timestamps.
- `docs` table is append-only. Stores content-addressed docs (Promise, Account, Tx, Signature, Order, Subscription — never Pocket bodies). `ON CONFLICT DO NOTHING` makes retries safe.
- `ledger_records` stores bank-minted records identified by ULID, not by content hash. `pair_ulid` (the peer record) and `deal_ulid` (the grouping key) are mandatory; `tx_ulid` is an internal binding column set at `submit_tx` — the doc body carries no Tx reference.
- `accounts` is a materialized view of balance state, derivable from the doc stream but kept O(1) for queries. Rows appear lazily when an Account doc is first presented (no pending/acknowledged dance).
- `deal_legs` holds per-bank leg state, keyed `(deal_ulid, bank_pubkey)`: role, predecessors, the full bank list (the lead needs it to await all holds), and state `created → approved → held → settled / rejected`. No bank sees the full graph.
- `holds` is keyed by `(account_hash, deal_ulid)` with a partial unique index on `(account_hash, bank_pubkey) WHERE active` — the double-spend gate.
- `subscriptions` + `subscription_watches` back the signature fan-out: one watch row per record/hash/deal key.
- `replay_window` is the replay-protection store.
- `bank_peers` caches peer-bank URLs (pubkey → URL) for discovery; fan-out itself delivers to the URL named in the Subscription doc.

You may use any database that can enforce:
1. At most one active hold per account.
2. Sum-to-zero (or sum-to-limit) on every settle.
3. Atomic state transitions (created → approved → held → settled / rejected).

SQLite with WAL mode, LevelDB with atomic batches, or an in-memory MVCC store would all work for smaller deployments.

---

## 7. Design decisions specific to this implementation

| Decision | Our choice | Alternatives you might choose |
|---|---|---|
| Server platform | Supabase Edge Functions | VPS, Cloudflare Workers, Fly.io, Raspberry Pi in your closet |
| Database | Supabase Postgres (multi-tenant) | SQLite, CockroachDB, DynamoDB, a custom WAL |
| Client | Bun CLI | Web UI, mobile app, Telegram bot, AI agent loop |
| Key storage (user) | `~/.barter/profile.json` (plaintext) | Browser localStorage + Argon2id, hardware wallet, OS keychain |
| Key storage (bank) | Supabase Secrets env var | HashiCorp Vault, AWS KMS, HSM, plaintext on disk (don't) |
| Signature delivery | Subscription push (fire-and-forget) + client relay (`barter nudge`) | WebSocket, SSE, message queue, gossip |
| Deal watching | On-demand `get_deal` polling (`barter status`) | Push notification, email digest, long-polling |
| Replay window | 100-ID LRU + 7-day TTL | Larger window, time-based only, in-memory Redis |
| Migration policy | No in-place migrations after launch (wipe demo banks if schema changes) | Proper forward-compatible migrations, Blue/Green deploys |
| Bank discovery | Hardcoded URL+pubkey in client config | Federated directory, on-chain registry, shared JSON file |
| Web UI | None in v1 | SPA, React, vanilla HTML, native app |
| N-bank trades | Full N-party via `barter deal`; `barter trade` is a bilateral convenience | Same client logic, more transfers |

---

## 8. What v1 does not do

Honest list of limitations in this implementation:

- **No web UI.** CLI only. Web is v1.5.
- **No `barter doctor`.** Self-health-check command lands in v1.5.
- **No cross-bank inbox aggregation.** Each `barter inbox` hits one bank.
- **No guaranteed push delivery.** Subscription fan-out is fire-and-forget with no retry; a lost push stalls the deal until any party relays the signatures (`barter nudge`).
- **No automated follow-signature collection.** Deal tokens travel out of band; each follow holder must run `barter accept` themselves.
- **No hold sweeper.** A hold orphaned by an abandoned deal stays until `reject_deal` releases it (see `TODOS.md`).
- **No NFT-like unique Promises.** Issued Promises are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No key rotation or recovery.** Forever-key in v1.
- **No rollback after a lead settles.** If a follow bank never settles, the lead is out — the lead/follow risk (PROTOCOL.md §2), resolved socially.

See `TODOS.md` for the v1.5+ roadmap.

---

## 9. Testing

| Test suite | Command | Purpose |
|---|---|---|
| Protocol (Bun) | `bun run test` | Canonical JSON, crypto, schemas, invite/deal-token codecs, deal builder |
| Deno suite | `bun run test:deno` | Everything Deno: the protocol golden vectors (cross-runtime parity) **plus** the full bank integration suite — `mint`, `direct_approval` (the bilateral walkthrough, reject paths, implicit accounts), `subscription` (fan-out, relay recovery, expiry), and `nparty` (four banks self-advance a branching deal to settled) |
| End-to-end | `./scripts/demo.sh` | Four simulated users mint, initiate, accept, and watch a branching multi-bank deal settle across live banks |

The Deno suite is load-bearing twice over: if Bun and Deno disagree on a canonical hash the protocol is broken, and the bank tests are the only automated check of the advance engine. Run it before every release.

---

## 10. Running your own bank (quickstart)

This is the v1 reference path. Adapt to your own infrastructure as needed.

```bash
# 1. Clone the repo and install
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install

# 2. Link a Supabase project
supabase login
supabase link --project-ref <your-project-ref>

# 3. Apply migrations
supabase db push

# 4. Generate a bank private key and stash it as a project secret
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
supabase secrets set --env-file /tmp/key.env
rm /tmp/key.env

# 5. Deploy the function
bun run scripts/sync-protocol.ts
supabase functions deploy bank-alice --no-verify-jwt

# 6. Hit it
curl https://<your-ref>.supabase.co/functions/v1/bank-alice/
```

You now have a bank. Tell your friends about it. They run `barter init` against your URL and you're a tiny central bank in a federation of exactly however many people you've invited.

> **Not using Supabase?** You need: (1) an HTTP server that can hold an ed25519 key, (2) a storage layer that enforces the invariants in PROTOCOL.md §9, (3) a way to expose `POST /rpc` and `GET /barter-bank.json` under the bank's canonical URL. The rest is up to you.
