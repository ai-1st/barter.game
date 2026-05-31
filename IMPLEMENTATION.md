# barter.game — v1 Reference Implementation Guide

> **This document is NOT the protocol contract.** It describes how *this repository* implements barter.game v1. If you are building your own bank or client, read `PROTOCOL.md` first for the invariant rules you must follow, then read this file for inspiration, file maps, and lessons from our specific choices.
>
> You may change anything in this document for your own implementation. The protocol doesn't care if you use Postgres or SQLite, Bun or Rust, Edge Functions or a VPS. It cares that you enforce the invariants in `PROTOCOL.md` §9.

---

## 1. Overview

The v1 reference implementation consists of:

- **`packages/protocol/`** — a TypeScript library of canonical JSON, crypto primitives, doc schemas, and invite formatting. Shared between the CLI and the server.
- **`apps/cli/`** — the `barter` command-line client. Init, mint, open, trade, confirm, settle, inbox.
- **`supabase/functions/`** — Supabase Edge Functions that act as bank processes. One function per bank in the demo; the protocol supports arbitrary separation.
- **`supabase/migrations/`** — Postgres schema. One database backs all demo banks; rows are scoped by `bank_pubkey`.

The demo runs two live banks (`bank-alice`, `bank-bob`) on a single Supabase project. A third bank can be added by creating a new Edge Function and generating a keypair.

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
| `src/schemas.ts` | Runtime validators for all six doc types. Zod-like without the dependency — plain TypeScript predicates. |
| `src/invite.ts` | Encode/decode `barter://` invite strings. |
| `src/deal.ts` | Deal-graph builder: given a set of transfers, build records, compute Tx hash, determine roles and predecessors. |
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
| `_shared/bank/db.ts` | Postgres queries: doc insert, balance update, hold acquire/release, tx state machine |
| `_shared/bank/peer.ts` | HTTP client for bank-to-bank calls (mostly vestigial in v1; used for discovery) |
| `_shared/bank/handlers/mint_promise.ts` | `mint_promise` — Promise + Account + Pocket creation |
| `_shared/bank/handlers/open_account.ts` | `open_account` — holder opens a receiving account |
| `_shared/bank/handlers/propose_leg.ts` | `propose_leg` — persist Tx slice, sign `approve` |
| `_shared/bank/handlers/hold_leg.ts` | `hold_leg` — acquire debit holds, sign `hold` |
| `_shared/bank/handlers/confirm_receipt.ts` | `confirm_receipt` — store holder confirmation, advance to `confirmed` when complete |
| `_shared/bank/handlers/settle_leg.ts` | `settle_leg` — verify predecessors, apply balances, release holds, sign `settle` |
| `_shared/bank/handlers/reject_leg.ts` | `reject_leg` — release holds, mark `rejected` |
| `_shared/bank/handlers/get.ts` | `get_promise`, `get_account_balance`, `list_accounts` — read-only queries |

### 4.4 The 24-hour abandonment sweeper

Holds that are not released by `settle` or `reject` within 24 hours are released by a background sweeper. This is a **hygiene mechanism**, not a correctness mechanism. The protocol has no timeouts (PROTOCOL.md §2.1). The sweeper exists because a crashed client could leave an account locked forever, and we prefer liveness over strictness for a demo.

In a production implementation you might:
- Keep the 24h sweep (simple, forgiving).
- Make it configurable per-bank.
- Remove it entirely and require manual operator intervention.

All are valid. The protocol does not specify sweeper behavior.

### 4.5 Replay window implementation

The replay window is stored in the `replay_window` table. The sweeper enforces:

1. Per-sender LRU cap: keep the 100 most recent IDs.
2. Idle TTL: drop anything older than 7 days.

The "whichever set is larger" rule means a sender that sends 200 IDs in an hour keeps 100; a sender that sends 5 IDs over two weeks keeps all 5 (assuming they're within the 7-day window).

These numbers are arbitrary and tuned for the demo. Your implementation may choose different caps.

### 4.6 Inbox polling

The CLI polls the bank inbox every 10 seconds. There is no WebSocket or SSE in v1. This is a client UX choice, not a protocol requirement. A web UI could use long-polling, server-sent events, or a push notification service without changing the protocol.

---

## 5. Client architecture (CLI)

### 5.1 Commands

| Command | Purpose |
|---|---|
| `barter init --bank <url>` | Pin a bank URL+pubkey in `~/.barter/profile.json` |
| `barter mint "<name>" [--integer] [--due YYYY-MM-DD] [--limit N]` | Mint a Promise at your default bank |
| `barter open <promise-hash> --bank <url>` | Open an Account to receive someone else's Promise |
| `barter trade --give ... --get ... --my-give-account ... --peer-give-account ... --peer-get-account ... --my-get-account ... --peer-pubkey ... --peer-bank ...` | Propose a cross-bank trade |
| `barter confirm <tx-hash>` | Sign `confirm_receipt` as a holder |
| `barter settle <tx-hash>` | Drive the settle cascade (lead settles first, then followers) |
| `barter inbox [--bank <url>]` | List pending Txs and balances at a bank |

The trade command is verbose because v1 requires 8 hashes explicitly. The invite-string format (`barter://...`) is implemented but not yet wired to the trade command's hot path; that is a v1.5 UX improvement.

### 5.2 Deal state machine (client-side)

`apps/cli/src/dealstate.ts` tracks the local state of a deal from proposal through settlement. It stores the full graph (the one thing the protocol says the client legitimately knows) and coordinates the multi-bank calls.

`apps/cli/src/orchestrate.ts` contains the topological settle logic: leads first, then followers in dependency order.

### 5.3 Profile storage

User keys are stored in `~/.barter/profile.json` as raw base58 private keys. There is no encryption, no passphrase, no hardware wallet integration. This is acceptable for a demo and unacceptable for production. v1.5 will add Argon2id or PBKDF2 key encryption.

> **Implementation detail:** How you store user keys is entirely up to you. The protocol only sees the pubkey on the wire.

---

## 6. Database schema (v1 reference)

See `SCHEMA.md` for the full schema, table definitions, indexes, triggers, and invariants. A quick summary of the load-bearing choices:

- `base58 TEXT` for all hashes, pubkeys, and signatures. No binary types — easier to debug, portable across languages.
- `NUMERIC` for balances. Exact arithmetic; never floating point.
- `TIMESTAMPTZ` for all timestamps.
- `docs` table is append-only. `ON CONFLICT DO NOTHING` makes retries safe.
- `accounts` is a materialized view of balance state, derivable from `docs` but kept O(1) for queries.
- `txs` holds per-bank leg state (role, predecessors, state). No bank sees the full graph.
- `holds` has a partial unique index on `(account_hash, bank_pubkey) WHERE active` — the double-spend gate.
- `replay_window` is the replay-protection store.
- `bank_peers` caches peer URLs. Vestigial on the trade path in v1 (banks don't call each other), kept for discovery.

You may use any database that can enforce:
1. At most one active hold per account.
2. Sum-to-zero (or sum-to-limit) on every settle.
3. Atomic state transitions (propose → hold → confirm → settled).

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
| Inbox notification | 10s CLI polling | WebSocket, SSE, push notification, email digest |
| Sweeper | 24h Postgres-based | Cron job, operator manual cleanup, no sweeper |
| Replay window | 100-ID LRU + 7-day TTL | Larger window, time-based only, in-memory Redis |
| Migration policy | No in-place migrations after launch (wipe demo banks if schema changes) | Proper forward-compatible migrations, Blue/Green deploys |
| Bank discovery | Hardcoded URL+pubkey in client config | Federated directory, on-chain registry, shared JSON file |
| Web UI | None in v1 | SPA, React, vanilla HTML, native app |
| N-bank trades | Protocol supports it; CLI demo caps at 2 for simplicity | Build a full N-party coordinator; it's just more client logic |

---

## 8. What v1 does not do

Honest list of limitations in this implementation:

- **No web UI.** CLI only. Web is v1.5.
- **No `barter doctor`.** Self-health-check command lands in v1.5.
- **No cross-bank inbox aggregation.** Each `barter inbox` hits one bank.
- **No automated multi-user confirm collection.** The client must reach each holder to gather `confirm_receipt` signatures; there is no push/notification layer (10s inbox polling only).
- **No NFT-like unique Promises.** Issued Promises are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No key rotation or recovery.** Forever-key in v1.
- **No automated settle-cascade retry.** If a downstream `settle_leg` fails, the client retries or the deal stalls with upstream legs already settled — the lead/follow risk (PROTOCOL.md §2), resolved socially.

See `TODOS.md` for the v1.5+ roadmap.

---

## 9. Testing

| Test suite | Command | Purpose |
|---|---|---|
| Protocol (Bun) | `bun run test` | Canonical JSON, crypto, schemas, invite format |
| Protocol (Deno) | `bun run test:deno` | Same golden vectors under Deno — cross-runtime parity |
| N-party (Deno) | `bun run test:nparty` | Full multi-bank settle cascade in a Deno test runner |
| End-to-end | `./scripts/demo.sh` | Two simulated users mint, trade, and settle across live banks |

The Deno suite is load-bearing. If Bun and Deno disagree on a canonical hash, the protocol is broken. Run it before every release.

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

> **Not using Supabase?** You need: (1) an HTTP server that can hold an ed25519 key, (2) a storage layer that enforces the invariants in PROTOCOL.md §9, (3) a way to expose `POST /rpc` and `GET /.well-known/barter-bank.json`. The rest is up to you.
