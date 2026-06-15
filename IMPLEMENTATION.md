# barter.game — v1 Reference Implementation Guide

> **This document is NOT the protocol contract.** It describes how *this repository* implements barter.game v1. If you are building your own bank or client, read `protocol/README.md` and `protocol/bank-schema.md` first for the invariant rules you must follow, then read this file for inspiration, file maps, and lessons from our specific choices.
>
> You may change anything in this document for your own implementation. The protocol doesn't care if you use Postgres or SQLite, Deno Deploy or a VPS. It cares that you enforce the invariants in `protocol/bank-schema.md` §3.

---

## 1. Overview

The v1 reference implementation consists of:

- **`packages/protocol/`** — a TypeScript library of canonical JSON, crypto primitives, doc schemas, the deal builder, and the invite / deal-token codecs. Shared between the CLI and the server.
- **`apps/cli/`** — the `barter` command-line client. Init, mint, account, invite, trade, deal, accept, status, nudge, subscribe, inbox.
- **`apps/bank/`** — the Deno Deploy bank server. One entrypoint serves one or more banks from a single Deno KV database; each bank is scoped by its pubkey.

The demo runs live banks on Deno Deploy. Additional banks can be added by setting another `BANK_<NAME>_PRIV_KEY` environment variable — no separate deploy is needed, because `apps/bank/main.ts` discovers and routes all configured banks at startup.

The old Supabase/Postgres implementation is archived in `old/supabase/` for reference.

---

## 2. Runtime & toolchain

| Layer | Choice | Rationale |
|---|---|---|
| Server runtime | Deno (Deno Deploy) | Native TypeScript, edge-deployed, stateless with Deno KV |
| Client runtime | Bun | Fast package install, native TypeScript runner |
| Protocol library | TypeScript, runs under Bun, Deno, and browser | Cross-runtime parity is the load-bearing guarantee |
| Database | Deno KV | Single-table key-space per bank; atomic check-and-set operations |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all target environments |
| Key storage (user) | `~/.barter/profile.json` on disk | v1 is CLI-first; web UI key storage is a v1.5 concern |
| Key storage (bank) | Deno Deploy env var (`BANK_<NAME>_PRIV_KEY`) | Injected at deploy time; never returned in RPC responses |

> **You can change any of these.** The protocol only requires ed25519 signatures, SHA-256, and RFC 8785 canonical JSON. If your stack is Rust + SQLite + WASM, that is a perfectly valid v1 implementation as long as the wire format and invariants match.

---

## 3. The `packages/protocol/` library

This is the most reusable part of the reference implementation. It is dependency-light and environment-agnostic.

| File | Purpose |
|---|---|
| `src/canonical.ts` | Hand-rolled RFC 8785 canonicalizer. Guaranteed byte-identical across Bun, Node, Deno, and browser. |
| `src/crypto.ts` | ed25519 sign/verify, SHA-256, base58 encode/decode. Thin wrappers around `@noble/*`. |
| `src/schemas.ts` | Runtime validators for all doc types (incl. Subscription, Address). Zod-like without the dependency — plain TypeScript predicates. |
| `src/invite.ts` | Encode/decode `barter://` invite strings (with bundled Account bodies) and `barterdeal:` deal tokens — the initiator → follow-holder handoff. |
| `src/deal.ts` | Deal builder: given transfer specs and bank-minted record ULIDs, assemble ONE Tx PER HOLDER (a disjoint exact cover of the records), compute hashes, lead/follow roles, and per-bank predecessors. |
| `src/index.ts` | Re-exports. |

The cross-runtime parity test is the most important test in the repo. It canonicalizes the same document under Bun and Deno and asserts the hashes match. If this test fails, every signature in the protocol is unverifiable across implementations.

**Reusing this code:** The protocol package is MIT-licensed (license file lands with public release). You can import it directly if you are building a TypeScript client or server. If you are building in another language, treat the source as the spec: port the canonicalizer exactly, keep the crypto primitives equivalent, and replicate the schema validators.

---

## 4. Server architecture (banks)

### 4.1 Deno Deploy entrypoint — `apps/bank/main.ts`

`main.ts` is the single Deno Deploy entrypoint. At startup it:

1. Scans `Deno.env` for `BANK_<NAME>_PRIV_KEY` variables via `env.ts`.
2. Derives each bank's pubkey from its private key.
3. Opens a single Deno KV handle with `Deno.openKv()`.
4. Routes incoming HTTP requests by bank name.

Routes per bank (where `<name>` is the lower-cased env var suffix, e.g. `alice`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/<name>/barter-bank.json` | Bank discovery document: pubkey, canonical URL, name, protocol version |
| `POST` | `/<name>/rpc` | JSON-RPC envelope endpoint |
| `GET` | `/<name>/address/<pubkey>` | Look up an Address doc by pubkey |
| `POST` | `/<name>/address` | Submit or update an Address doc |

Because one process serves all configured banks, adding a bank is just setting another env var and redeploying — no new function, no new migration set.

### 4.2 Multi-tenant Deno KV

One Deno KV database serves all banks in a deployment. Every key is prefixed with the bank's pubkey (`[bankPubkey, …]`). The `BankDB` class in `db.ts` is instantiated per request with the target bank's pubkey, so every KV operation is automatically scoped. There is no shared cross-bank namespace; missing the bank prefix would be a bug.

This was chosen for operational simplicity (one project, one KV, one deploy). True federation would put each bank in its own Deno Deploy project. The protocol supports either; this is a deployment choice.

### 4.3 Handler file map

| File | Purpose |
|---|---|
| `env.ts` | Scan `BANK_<NAME>_PRIV_KEY` env vars and derive pubkeys |
| `main.ts` | Deno.serve entrypoint, routing, KV open |
| `rpc.ts` | Envelope validation, signature check, replay-window claim, method dispatch |
| `registry.ts` | Method name → handler function map |
| `db.ts` | Deno KV operations: doc insert, balance update, hold acquire/release, leg state, subscriptions, replay window, peer cache |
| `advance.ts` | The advance engine — `advanceDeal()` self-advances a leg through hold and settle (see §4.4) |
| `subscriptions.ts` | Signature fan-out: POST bank-signed `notify_signatures` envelopes to matching subscribers (fire-and-forget) |
| `peer.ts` | HTTP client for signed bank-to-bank calls |
| `handlers/intake.ts` | Shared doc intake — Voucher/Account/Address docs attached to any mutating call; accounts come into existence here (Pocket bodies are rejected) |
| `handlers/mint_voucher.ts` | `mint` — the mint as the first record pair on two distinct pockets, settled immediately |
| `handlers/create_records.ts` | `create_records` — bank mints debit/credit record pairs with ULIDs, stores its slice of the settle topology |
| `handlers/submit_tx.ts` | `submit_tx` — verify a holder's lead/follow Tx signature, issue per-record `approve`/`reject`, advance the leg |
| `handlers/subscribe.ts` | `subscribe` — store a Subscription doc + its watch keys |
| `handlers/notify_signatures.ts` | `notify_signatures` — accept pushed/relayed signatures (from anyone), verify, store, re-advance touched deals |
| `handlers/reject_deal.ts` | `reject_deal` — participant-initiated cancellation: release holds, mark `rejected`, fan out |
| `handlers/get_deal.ts` | `get_deal` — leg state + record bodies + deal signatures (token verification, polling, relay) |
| `handlers/get.ts` | `get_voucher`, `get_account_balance`, `list_accounts`, address directory — read-only queries |

Removed from the old model: `open_account` (accounts are implicit — `intake.ts`), `propose_leg` and `confirm_receipt` (both subsumed by the holder's own Tx signature in `submit_tx`), and `hold_leg` / `settle_leg` as client RPCs (that logic moved into the advance engine).

### 4.4 The advance engine — banks self-advance, event-driven

There is no client `settle` command and no cron job. `advanceDeal(deal)` in `advance.ts` runs after every event that can unblock a leg — a `submit_tx` that completes approval, or a signature arriving via `notify_signatures` — and moves the leg as far as it can:

1. **`approved` → `held`**: acquire holds on the owned debit accounts (keyed by account hash; a conflict backs off quietly and is retried on the next event), sign `{deal, action: "hold"}`, fan out.
2. **`held` → `settled`, lead leg**: settle once valid `hold` signatures from **every other bank in the deal** have been observed. The lead settles first, bearing the lead/follow risk.
3. **`held` → `settled`, follow leg**: settle once verified `{deal, action: "settle"}` signatures from all predecessor banks are stored; their hashes go into this bank's settle `Signature.seen` — the verifiable proof chain.
4. Settle applies the balance deltas for every owned record, releases the holds, signs `settle`, and fans out. Idempotent by state, never by replay.

Blocked conditions return quietly; the next incoming signature retries. Authority never comes from the caller — holds require a fully approved leg, and settles require stored, verified peer signatures.

A hold abandoned by a dead deal currently stays until `reject_deal` releases it; an operator hold-sweeper is a hygiene item on the roadmap (`TODOS.md`), not a correctness mechanism — the protocol has no timeouts.

### 4.5 Replay window implementation

The replay window is stored under the key prefix `[bankPubkey, "replay", senderPubkey, id, toPubkey]`. `claimUlid` uses an atomic KV check-and-set; a failed claim returns `-32002`. The sweeper enforces:

1. Idle TTL: drop anything older than 7 days.

There is no explicit per-sender LRU cap in the Deno KV implementation — the TTL is the bounding mechanism. These numbers are arbitrary and tuned for the demo. Your implementation may choose different caps.

### 4.6 Subscription fan-out and client relay

Signature delivery is push-based: the initiating client sends Subscription docs to each bank (the CLI cross-subscribes the banks in a deal to each other by default), and each bank POSTs a bank-signed `notify_signatures` JSON-RPC envelope to the subscription's URL whenever it creates a matching signature. Pushes are fire-and-forget with a short timeout — a lost push never fails the originating request.

The recovery path is client relay: `barter nudge` reads every bank's signatures via `get_deal` and delivers them to every other bank via the same `notify_signatures` method. Signatures carry their own authority (signer pubkey + ed25519 sig), so banks accept them from anyone. Clients watching a deal use `barter status` (on-demand `get_deal` polling); there is no WebSocket or SSE in v1 — a client UX choice, not a protocol requirement.

---

## 5. Client architecture (CLI)

### 5.1 Commands

| Command | Purpose |
|---|---|
| `barter init --bank <url>` | Pin a bank URL+pubkey in `~/.barter/profile.json` |
| `barter mint "<name>" --amount N [--integer] [--due YYYY-MM-DD] [--limit N]` | Mint a Voucher: builds two Pocket/Account pairs locally, the bank settles the first record pair immediately |
| `barter account <voucher-hash> [--name <pocket>]` | Author a receiving Account locally — no bank call; accounts are implicit |
| `barter invite --give <voucher>:N --get <voucher>:N` | Offer a swap: prints a signed `barter://` string with account hashes + bundled Account bodies |
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

See `SCHEMA.md` for the full Deno KV key-space reference, value shapes, and atomic operations. A quick summary of the load-bearing choices:

- `base58 TEXT` for all hashes, pubkeys, and signatures. No binary types — easier to debug, portable across languages.
- Balances stored as strings. Exact arithmetic; never floating point.
- ISO 8601 strings for timestamps.
- `docs` keys are append-only. Store content-addressed docs (Voucher, Account, Tx, Signature, Order, Subscription, Address — never Pocket bodies). Idempotent inserts make retries safe.
- `ledger_records` stores bank-minted records identified by ULID, not by content hash. `pair_ulid` (the peer record) and `deal_ulid` (the grouping key) are mandatory; `tx_ulid` is internal bookkeeping set at `submit_tx` — the doc body carries no Tx reference.
- `accounts` is a materialized balance row per Account doc, created lazily on first intake.
- `legs` holds per-bank leg state, keyed `(bankPubkey, "legs", dealUlid)`: role, predecessors, the full bank list (the lead needs it to await all holds), and state `created → approved → held → settled / rejected`. No bank sees the full graph.
- `holds` is keyed by `(bankPubkey, "holds", accountHash)` — at most one active hold per account is enforced by atomic check-and-set on that single key.
- `subscriptions` + `subscription_watches` back the signature fan-out: one watch row per record/hash/deal key.
- `replay` keys implement replay protection per `(sender, id, to)`.
- `peers` caches peer-bank URLs (pubkey → URL) for discovery; fan-out itself delivers to the URL named in the Subscription doc.

You may use any database that can enforce:
1. At most one active hold per account.
2. Sum-to-zero (or sum-to-limit) on every settle.
3. Atomic state transitions (created → approved → held → settled / rejected).

SQLite with WAL mode, LevelDB with atomic batches, or an in-memory MVCC store would all work for smaller deployments.

---

## 7. Design decisions specific to this implementation

| Decision | Our choice | Alternatives you might choose |
|---|---|---|
| Server platform | Deno Deploy | VPS, Cloudflare Workers, Fly.io, Raspberry Pi in your closet |
| Database | Deno KV (single-table, bank-prefixed) | SQLite, Postgres, CockroachDB, DynamoDB, a custom WAL |
| Client | Bun CLI | Web UI, mobile app, Telegram bot, AI agent loop |
| Key storage (user) | `~/.barter/profile.json` (plaintext) | Browser localStorage + Argon2id, hardware wallet, OS keychain |
| Key storage (bank) | Deno Deploy env var | HashiCorp Vault, AWS KMS, HSM, plaintext on disk (don't) |
| Signature delivery | Subscription push (fire-and-forget) + client relay (`barter nudge`) | WebSocket, SSE, message queue, gossip |
| Deal watching | On-demand `get_deal` polling (`barter status`) | Push notification, email digest, long-polling |
| Replay window | 7-day TTL | Larger window, time-based only, in-memory Redis |
| Migration policy | No in-place migrations after launch (wipe demo banks if schema changes) | Proper forward-compatible migrations, Blue/Green deploys |
| Bank discovery | Hardcoded URL+pubkey in client config, verified against `/<name>/barter-bank.json` | Federated directory, on-chain registry, shared JSON file |
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
- **No NFT-like unique Vouchers.** Issued Vouchers are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No key rotation or recovery.** Forever-key in v1.
- **No rollback after a lead settles.** If a follow bank never settles, the lead is out — the lead/follow risk (protocol/README.md §2), resolved socially.

See `TODOS.md` for the v1.5+ roadmap.

---

## 9. Testing

| Test suite | Command | Purpose |
|---|---|---|
| Protocol (Bun) | `bun run test` | Canonical JSON, crypto, schemas, invite/deal-token codecs, deal builder |
| Deno suite | `bun run test:deno` | Everything Deno: the protocol golden vectors (cross-runtime parity) **plus** the full bank integration suite — `mint`, `direct_approval` (the bilateral walkthrough, reject paths, implicit accounts), `subscription` (fan-out, relay recovery, expiry), and `nparty` (four banks self-advance a branching deal to settled) |
| End-to-end local | `./scripts/demo-local.sh` | Four simulated users mint, initiate, accept, and watch a branching multi-bank deal settle against a local Deno server |
| End-to-end deployed | `./scripts/demo-deploy.sh` | Same demo against live Deno Deploy banks (set `BARTER_BANK_*_URL` env vars) |

The Deno suite is load-bearing twice over: if Bun and Deno disagree on a canonical hash the protocol is broken, and the bank tests are the only automated check of the advance engine. Run it before every release.

---

## 10. Running your own bank (quickstart)

This is the v1 reference path on Deno Deploy. Adapt to your own infrastructure as needed.

```bash
# 1. Clone the repo and install
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install

# 2. Generate a bank private key
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
#    (the file contains one line: BANK_ALICE_PRIV_KEY=<base58>)

# 3. Create a Deno Deploy project and link it to this repo
#    - Go to https://deno.com/deploy
#    - Create a project; note its name for the next step
#    - Connect the GitHub repository

# 4. Set repository variables and secrets in GitHub
#    - Variable: DENO_DEPLOY_PROJECT = <your-project-name>
#    - Secret:   BANK_ALICE_PRIV_KEY = <the base58 key from /tmp/key.env>
#    You can serve more banks by adding BANK_BOB_PRIV_KEY, BANK_CAROL_PRIV_KEY, etc.

# 5. Push to main (or trigger the workflow)
#    .github/workflows/deploy.yml auto-deploys apps/bank/main.ts on every push to main.

# 6. Verify it's live
curl https://<your-project>.deno.dev/alice/barter-bank.json
```

You now have a bank. Tell your friends about it. They run `barter init` against your URL and you're a tiny central bank in a federation of exactly however many people you've invited.

> **Not using Deno Deploy?** You need: (1) an HTTP server that can hold an ed25519 key, (2) a storage layer that enforces the invariants in `protocol/bank-schema.md` §3, (3) a way to expose `POST /<name>/rpc`, `GET /<name>/barter-bank.json`, and the address directory endpoints under the bank's canonical URL. The rest is up to you.
