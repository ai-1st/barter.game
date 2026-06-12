# barter.game — Agent Guide

> This file is for AI coding agents. If you are reading this, you are about to modify code in a federated mutual-credit ledger. Read the section headers that match your task before touching files.

## Project overview

barter.game is a **federated mutual-credit ledger**. Every user and every bank is an ed25519 keypair. Users mint personal currencies ("1 logo", "1 hour of consulting"), trade them across banks, and settle via a signed, content-addressed protocol. There is no central authority; trust is local and socially enforced.

This repo contains:

- The **protocol library** (`packages/protocol/`) — canonical JSON, crypto, doc schemas, invite formatting.
- The **CLI client** (`apps/cli/`) — the `barter` command that drives the protocol end-to-end.
- The **bank server** (`supabase/functions/`) — Supabase Edge Functions acting as federated bank processes.
- The **website** (`website/`) — Hugo/Hextra static site.

v1 is CLI-only; a web UI is on the v1.5 roadmap (`TODOS.md`).

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Package manager | Bun | `bun.lock` is the lockfile. Use `bun install`, not `npm install`. |
| Client runtime | Bun | Native TypeScript runner, fast installs. |
| Server runtime | Deno (via Supabase Edge Functions) | Sandboxed, cold-start friendly. |
| Protocol lib | TypeScript (ES modules) | Must run identically under Bun, Deno, and browser. |
| Database | Postgres (Supabase managed) | ACID, `NUMERIC` exact arithmetic, multi-tenant via `bank_pubkey`. |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all targets. |
| Website | Hugo + Hextra theme | Built with `hugo`; deployed via Netlify. |
| Key storage (user) | `~/.barter/profile.json` on disk | Plaintext in v1; encryption is v1.5. |
| Key storage (bank) | Supabase Secrets (`BANK_<NAME>_PRIV_KEY`) | Injected as env var at Edge Function cold start. |

## Monorepo structure

```
barter.game/
├── package.json              # Root workspace manifest (workspaces: packages/*, apps/*)
├── tsconfig.json             # Shared TypeScript config (strict, ES2022, bundler resolution)
├── deno.json                 # Deno config for Edge Functions and Deno tests
├── bun.lock                  # Bun lockfile
├── packages/
│   └── protocol/             # @barter.game/protocol — the canonical library
│       ├── src/
│       │   ├── canonical.ts  # RFC 8785 hand-rolled canonicalizer (load-bearing)
│       │   ├── crypto.ts     # ed25519 sign/verify, SHA-256, base58
│       │   ├── schemas.ts    # Runtime doc validators (plain TS predicates, incl. Subscription)
│       │   ├── invite.ts     # barter:// invite strings + barterdeal: deal-token codec
│       │   ├── deal.ts       # Deal builder: per-holder Txs, lead/follow roles, settle topology
│       │   └── index.ts      # Re-exports
│       ├── test/             # Bun test suite
│       └── test-deno/        # Deno test suite (same golden vectors)
├── apps/
│   └── cli/                  # @barter.game/cli
│       ├── src/
│       │   ├── index.ts      # CLI entrypoint (command router)
│       │   ├── client.ts     # HTTP RPC client
│       │   ├── profile.ts    # ~/.barter/profile.json read/write
│       │   ├── docstore.ts   # ~/.barter/docs/ — client-held docs; Pocket bodies never leave
│       │   ├── dealstate.ts  # ~/.barter/deals/ — initiator's deal state, keyed by deal ULID
│       │   ├── orchestrate.ts # createRecordsAndLead / submitFollow / relayAll (banks self-advance)
│       │   └── commands/     # init, mint, account, invite, trade, deal, accept, status, nudge, subscribe, inbox
│       └── package.json
├── supabase/
│   ├── migrations/           # Postgres SQL schema (single baseline migration)
│   ├── functions/
│   │   ├── _shared/bank/     # Shared bank code (rpc, handlers, advance engine, subscriptions, db)
│   │   │   ├── rpc.ts        # Envelope validation, sig check, replay window, dispatch
│   │   │   ├── registry.ts   # Method name → handler map
│   │   │   ├── server.ts     # Bank bootstrap: load key, start HTTP listener
│   │   │   ├── db.ts         # Postgres queries
│   │   │   ├── advance.ts    # Advance engine: legs self-advance through hold → settle
│   │   │   ├── subscriptions.ts # Signature fan-out (bank-signed notify_signatures pushes)
│   │   │   ├── peer.ts       # HTTP client for signed bank-to-bank calls
│   │   │   ├── handlers/     # One file per RPC method (+ intake.ts shared doc intake)
│   │   │   └── test-deno/    # Bank integration tests (mint, direct approval, subscriptions, N-party)
│   │   ├── bank-alice/       # Edge Function entrypoint
│   │   ├── bank-bob/
│   │   ├── bank-carol/
│   │   └── bank-dave/
│   └── config.toml           # Supabase CLI config
├── scripts/
│   ├── demo.sh               # End-to-end multi-party demo (bash + jq)
│   ├── genkey.ts             # Generate ed25519 keypair for a new bank
│   └── sync-protocol.ts      # Copy protocol sources into _shared/protocol/ with import rewrites
├── website/                  # Hugo site (Hextra theme)
└── docs/                     # Legacy design notes
```

## Build and test commands

All commands run from the repo root.

```bash
# Install dependencies
bun install

# Build all workspaces
bun run build

# Type-check all workspaces
bun run typecheck

# Run the full test matrix (this is the gate before any commit)
bun run test:all
```

### Test breakdown

| Command | Runtime | What it tests |
|---|---|---|
| `bun run test` | Bun | Protocol canonical JSON, crypto, schemas, invites/deal tokens, deal builder |
| `bun run test:deno` | Deno | Golden vectors under Deno (**cross-runtime parity**) + the full bank integration suite: mint, direct approval, subscriptions/fan-out, N-party self-advance |
| `./scripts/demo.sh` | Bash + Bun | End-to-end against live banks (needs deployed Supabase project) |

The **Deno suite is load-bearing**. If Bun and Deno disagree on a canonical hash, every signature in the protocol becomes unverifiable across implementations — and the bank tests in it are the only automated check of the advance engine. Run it before every release.

### Individual workspace commands

```bash
# Protocol only
bun --filter '@barter.game/protocol' test
bun --filter '@barter.game/protocol' typecheck

# CLI only
bun --filter '@barter.game/cli' start
```

### Website

```bash
# Build (requires Hugo + Go)
cd website && hugo mod get && hugo --gc --minify
```

## Code style guidelines

- **Language**: TypeScript, ES modules (`"type": "module"`), `.ts` extension on all imports.
- **Strictness**: `strict: true` in tsconfig. `noUncheckedIndexedAccess: true` at root. No `any` without comment.
- **Formatting**: No enforced formatter yet. Match the existing style:
  - 2-space indent.
  - Single quotes for strings unless interpolating.
  - Explicit return types on exported functions.
  - JSDoc-style block comments for load-bearing invariants.
- **Runtime parity**: Any code in `packages/protocol/` must run under Bun, Deno, and browser. Avoid:
  - Node-only APIs (`fs`, `path`, `crypto` module).
  - `Buffer` — use `Uint8Array`.
  - `process.env` — use runtime-specific injection outside the protocol package.
- **Canonical JSON**: The hand-rolled canonicalizer in `packages/protocol/src/canonical.ts` is the single source of truth. Do not swap it for an npm package. Any change to it must be accompanied by new golden vectors and a passing Deno test.

## Testing instructions

### Adding a test to the protocol package

1. Add a Bun test in `packages/protocol/test/<name>.test.ts` using `bun:test`.
2. If the test covers canonical JSON, crypto, or anything runtime-sensitive, add an equivalent Deno test in `packages/protocol/test-deno/<name>.deno-test.ts` using `Deno.test`.
3. Keep golden vectors in `packages/protocol/test/fixtures/` as JSON.
4. Run `bun run test:all` before committing.

### Adding a handler to the bank server

1. Create `supabase/functions/_shared/bank/handlers/<method_name>.ts`.
2. Export a handler function and register it in `registry.ts`.
3. The handler must:
   - Validate the envelope signature via `rpc.ts`.
   - Filter every DB query on `bank_pubkey`.
   - Return typed JSON-RPC responses.
4. Add a Deno integration test if the handler changes the state machine.

### Running the end-to-end demo

Requires a Supabase project with `bank-alice`, `bank-bob`, `bank-carol`, `bank-dave` deployed and secrets set.

```bash
# Optional: override the project URL
export BARTER_PROJECT_URL=https://<your-ref>.supabase.co
./scripts/demo.sh
```

## Security considerations

- **Private keys**: User keys are stored plaintext in `~/.barter/profile.json`. This is intentional for v1 but unacceptable for production. Do not add real value to these keys.
- **Bank keys**: Loaded from `Deno.env.get("BANK_<NAME>_PRIV_KEY")`. Never log them, never return them in RPC responses.
- **Replay protection**: Every RPC envelope carries a ULID `id` bound to `(sender_pubkey, recipient_pubkey)`. The recipient stores seen triples in `replay_window` and rejects duplicates with `-32002`.
- **Signature verification**: Every inbound request is verified against its `pubkey` before any handler runs. The `to` field must match the recipient bank's pubkey.
- **Pocket privacy**: Banks must NEVER accept or store Pocket bodies — `account.pocket` is an opaque hash, and the bodies stay on the holder's machine (`~/.barter/docs/`). `intake.ts` rejects Pocket docs; do not add a server-side code path that receives one.
- **Double-spend gate**: A partial unique index on `holds` enforces at most one active hold per account. Concurrent hold attempts surface as `-32003` or, inside the advance engine, a quiet back-off retried on the next event.
- **Sum invariant**: On every settle, the bank must enforce that balances across all accounts for a given Promise sum to zero (or the agreed limit).
- **Pubkey pinning**: Clients pin `pubkey + url` at `init` time. `.well-known/barter-bank.json` is fetched and compared against the pin; divergence fails closed.
- **No RLS in v1**: Edge Functions use the service-role key. Direct DB access is operator-only. RLS is a v1.5 item.

## Key documentation (read before making changes)

| File | Purpose | Read this if you are... |
|---|---|---|
| `SETTLEMENT_WALKTHROUGH.md` | **The canonical narrative** of the model — mint, direct approval, subscriptions, hold, settle. Read this first. | Touching anything protocol-adjacent |
| `README.md` | Project intro, quickstart, CLI usage | New to the repo |
| `ETHOS.md` | Design beliefs and priors | Changing protocol semantics |
| `PROTOCOL.md` | **The invariant contract.** Every implementation must follow this. | Building a bank, client, or alternative implementation |
| `IMPLEMENTATION.md` | How *this repo* implements v1 (file maps, design choices) | Modifying server or client code |
| `SCHEMA.md` | Reference database schema | Changing migrations or DB queries |
| `TODOS.md` | v1.5+ roadmap and speculative extensions | Planning new features |

## Deployment notes

### Deploying a new bank

```bash
# 1. Generate a keypair
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
supabase secrets set --env-file /tmp/key.env
rm /tmp/key.env

# 2. Sync protocol sources into _shared/
bun run scripts/sync-protocol.ts

# 3. Deploy the Edge Function
supabase functions deploy bank-alice --no-verify-jwt
```

### Syncing protocol changes to the server

The server does not import `packages/protocol/` directly. Run `bun run scripts/sync-protocol.ts` before any `supabase functions deploy`. This script:

1. Copies `packages/protocol/src` into `supabase/functions/_shared/protocol/`.
2. Rewrites bare npm specifiers to Deno `npm:` specifiers.
3. Adds a `GENERATED` header to each file.

**Never edit files in `_shared/protocol/` directly.** They are overwritten on every sync.

### Website

The Hugo site deploys automatically via Netlify (`netlify.toml`). Build command:

```bash
cd website && hugo mod get && hugo --gc --minify
```

## Development conventions

- **Content-addressed docs**: Every doc (Promise, Account, Tx, Signature, etc.) is canonicalized, SHA-256-hashed, and stored/addressed by its base58 hash. References between docs use hashes, not surrogate IDs.
- **Bank scoping**: Every bank-scoped table has `bank_pubkey TEXT NOT NULL`. Every query must filter on it. Missing the filter is a bug.
- **Base58 everywhere**: Hashes, pubkeys, and signatures are stored as base58 strings in `TEXT` columns. No binary types.
- `NUMERIC` for balances: Never use floating-point for ledger math.
- **Banks self-advance**: Clients only create records (`create_records`) and submit holder-signed Txs (`submit_tx`). From there each bank advances its own leg `created → approved → held → settled` event-driven — `advanceDeal()` re-evaluates on every `submit_tx` / `notify_signatures`, with no cron or background worker. Signatures travel between banks via subscription fan-out, with client relay (`barter nudge`) as the floor. `reject_deal` terminates from any pre-settled state.
- **Visibility boundary**: No bank ever sees another bank's records. A bank sees only the records of the promises it issues, the holder Txs that touch them, and the deal-level signatures of its peers.
- **Migration policy (v1)**: No in-place migrations after launch. If schema changes, wipe demo banks. v1.5 will introduce forward-compatible migrations.
- **Comments**: Load-bearing invariants are commented with `//` or `/* */` blocks. JSDoc is used for exported public APIs.
