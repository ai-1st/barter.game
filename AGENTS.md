# barter.game — Agent Guide

> This file is for AI coding agents. If you are reading this, you are about to modify code in a federated mutual-credit ledger. Read the section headers that match your task before touching files.

## Project overview

barter.game is a **federated mutual-credit ledger**. Every user and every bank is an ed25519 keypair. Users mint personal currencies ("1 logo", "1 hour of consulting"), trade them across banks, and settle via a signed, content-addressed protocol. There is no central authority; trust is local and socially enforced.

This repo contains:

- The **protocol library** (`packages/protocol/`) — canonical JSON, crypto, doc schemas, invite formatting.
- The **CLI client** (`apps/cli/`) — the `barter` command that drives the protocol end-to-end.
- The **bank server** (`apps/bank/`) — Deno Deploy project serving one or more federated bank processes.
- The **website** (`website/`) — Hugo/Hextra static site.
- The **old Supabase implementation** (`old/supabase/`) — preserved for reference.

v1 is CLI-only; a web UI is on the v1.5 roadmap (`TODOS.md`).

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Package manager | Bun | `bun.lock` is the lockfile. Use `bun install`, not `npm install`. |
| Client runtime | Bun | Native TypeScript runner, fast installs. |
| Server runtime | Deno (Deno Deploy) | Auto-deployed on merge to `main`; stateless, uses Deno KV. |
| Protocol lib | TypeScript (ES modules) | Must run identically under Bun, Deno, and browser. |
| Database | Deno KV | Single-table design with `bank_pubkey` key prefixes; atomic transactions. |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all targets. |
| Website | Hugo + Hextra theme | Built with `hugo`; deployed via Netlify. |
| Key storage (user) | `~/.barter/profile.json` on disk | Plaintext in v1; encryption is v1.5. |
| Key storage (bank) | Deno Deploy env vars (`BANK_<NAME>_PRIV_KEY`) | One or more bank keys per Deploy project. |

## Monorepo structure

```
barter.game/
├── package.json              # Root workspace manifest (workspaces: packages/*, apps/*)
├── tsconfig.json             # Shared TypeScript config (strict, ES2022, bundler resolution)
├── deno.json                 # Deno config (imports, test include, unstable KV)
├── bun.lock                  # Bun lockfile
├── .github/workflows/        # CI/CD: Deno Deploy autodeploy on merge
├── packages/
│   └── protocol/             # @barter.game/protocol — the canonical library
│       ├── src/
│       │   ├── canonical.ts  # RFC 8785 hand-rolled canonicalizer (load-bearing)
│       │   ├── crypto.ts     # ed25519 sign/verify, SHA-256, base58
│       │   ├── schemas.ts    # Runtime doc validators (plain TS predicates)
│       │   ├── invite.ts     # barter:// invite strings + barterdeal: deal-token codec
│       │   ├── deal.ts       # Deal builder: per-holder Txs, lead/follow roles, settle topology
│       │   └── index.ts      # Re-exports
│       ├── test/             # Bun test suite
│       └── test-deno/        # Deno test suite (same golden vectors)
├── apps/
│   ├── bank/                 # Deno Deploy bank server
│   │   ├── main.ts           # Deno.serve entrypoint, routing, KV open
│   │   ├── env.ts            # BANK_<NAME>_PRIV_KEY loader
│   │   ├── db.ts             # Deno KV single-table BankDB
│   │   ├── rpc.ts            # JSON-RPC envelope validation + dispatch
│   │   ├── registry.ts       # Method name → handler map
│   │   ├── advance.ts        # Self-advance engine: approved → held → settled
│   │   ├── subscriptions.ts  # Signature fan-out (notify_signatures pushes)
│   │   ├── peer.ts           # Peer bank discovery client
│   │   ├── handlers/         # One file per RPC method (+ intake.ts)
│   │   └── test-deno/        # Bank integration tests (mint, direct approval, subscriptions, N-party)
│   └── cli/                  # @barter.game/cli
│       ├── src/
│       │   ├── index.ts      # CLI entrypoint (command router)
│       │   ├── client.ts     # HTTP RPC client
│       │   ├── profile.ts    # ~/.barter/profile.json read/write
│       │   ├── docstore.ts   # ~/.barter/docs/ — client-held docs; Pocket bodies never leave
│       │   ├── dealstate.ts  # ~/.barter/deals/ — initiator's deal state, keyed by deal ULID
│       │   ├── orchestrate.ts # createRecordsAndLead / submitFollow / relayAll
│       │   └── commands/     # init, mint, account, invite, trade, deal, accept, status, nudge, subscribe, inbox
│       └── package.json
├── scripts/
│   ├── demo-local.sh         # End-to-end multi-party demo against a local Deno server
│   ├── demo-deploy.sh        # (optional) same demo against deployed Deno Deploy banks
│   └── genkey.ts             # Generate ed25519 keypair for a new bank
├── old/                      # Archived Supabase/Postgres implementation
│   ├── supabase/
│   └── scripts/
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
| `./scripts/demo-local.sh` | Bash + Bun + Deno | End-to-end against a local Deno server (generates keys, starts server, runs CLI demo) |
| `./scripts/demo-deploy.sh` | Bash + Bun | End-to-end against deployed Deno Deploy banks (set `BARTER_BANK_*_URL` env vars) |

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

1. Create `apps/bank/handlers/<method_name>.ts`.
2. Export a handler function and register it in `apps/bank/registry.ts`.
3. The handler must:
   - Validate the envelope signature via `rpc.ts`.
   - Scope every KV operation to this bank's pubkey.
   - Return typed JSON-RPC responses.
4. Add a Deno integration test in `apps/bank/test-deno/` if the handler changes the state machine.

### Running the end-to-end demo locally

```bash
# Generates keys, starts a local Deno server, runs the CLI demo
./scripts/demo-local.sh
```

## Security considerations

- **Private keys**: User keys are stored plaintext in `~/.barter/profile.json`. This is intentional for v1 but unacceptable for production. Do not add real value to these keys.
- **Bank keys**: Loaded from `Deno.env.get("BANK_<NAME>_PRIV_KEY")`. Never log them, never return them in RPC responses.
- **Signing model**: Users sign Promise, Order, Tx, and Address docs. Banks sign Record and Offer docs. Account and Pocket docs are NOT signed; their authority comes from being referenced by signed Txs/Orders/mint records.
- **Replay protection / idempotency**: Every RPC envelope carries a ULID `id` bound to `(sender_pubkey, recipient_pubkey)`. The recipient stores seen triples in KV and rejects exact duplicates with `-32002`. In addition, state-changing handlers are idempotent where it matters: `create_records` checks the existing leg state before minting a duplicate record pair, and `mint` is bounded by `Promise.limit` and the envelope replay window. A fresh signed envelope cannot be used to double-apply a mint or re-create records for the same deal leg.
- **Signature verification**: Every inbound request is verified against its `pubkey` before any handler runs. The `to` field must match the recipient bank's pubkey.
- **Pocket privacy**: Banks must NEVER accept or store Pocket bodies — `account.pocket` is an opaque hash, and the bodies stay on the holder's machine (`~/.barter/docs/`). `intake.ts` rejects Pocket docs; do not add a server-side code path that receives one.
- **Double-spend gate**: An atomic KV check-and-set on the active-hold key enforces at most one active hold per account. Concurrent hold attempts surface as `-32003` or, inside the advance engine, a quiet back-off retried on the next event.
- **Sum invariant**: On every settle, the bank must enforce that balances across all accounts for a given Promise sum to zero (or the agreed limit).
- **Pubkey pinning**: Clients pin `pubkey + url` at `init` time. `<bank-url>/barter-bank.json` is fetched and compared against the pin; divergence fails closed.

## Key documentation (read before making changes)

| File | Purpose | Read this if you are... |
|---|---|---|
| `MASTER-INPUT.md` | **Source-of-truth design input** from the product owner — mint, direct approval, subscriptions, hold, settle. Read this first. | Touching anything protocol-adjacent |
| `scenarios/*.md` | Step-by-step user/matchmaker/bank interaction traces | Implementing or debugging specific flows |
| `README.md` | Project intro, quickstart, CLI usage | New to the repo |
| `ETHOS.md` | Design beliefs and priors | Changing protocol semantics |
| `protocol/` directory | **The invariant contract.** Split across `README.md`, `base.md`, `bank-schema.md`, and `bank-rpc.md`. Every implementation must follow these. | Building a bank, client, or alternative implementation |
| `IMPLEMENTATION.md` | How *this repo* implements v1 (file maps, design choices) | Modifying server or client code |
| `SCHEMA.md` | Reference Deno KV key-space schema | Changing KV keys or atomic operations |
| `TODOS.md` | v1.5+ roadmap and speculative extensions | Planning new features |
| `scenarios/*.md` | Step-by-step user/matchmaker/bank interaction traces | Implementing or debugging specific flows |

## Deployment notes

### Deno Deploy autodeploy

Pushes to `main` trigger `.github/workflows/deploy.yml`, which deploys `apps/bank/main.ts` to the Deno Deploy project named in the repository variable `DENO_DEPLOY_PROJECT`.

To set up:

1. Create a Deno Deploy project at https://deno.com/deploy and link it to this GitHub repo.
2. Set the repository variable `DENO_DEPLOY_PROJECT` to the project name.
3. In the Deno Deploy dashboard, set env vars `BANK_<NAME>_PRIV_KEY` for each bank the project serves (e.g., `BANK_ALICE_PRIV_KEY`).

### Deploying a new bank locally

```bash
# 1. Generate a keypair
bun run scripts/genkey.ts
# 2. Set BANK_ALICE_PRIV_KEY and run locally
deno run --allow-env --allow-net apps/bank/main.ts
```

### Syncing protocol changes to the server

`apps/bank/` imports `packages/protocol/src/index.ts` directly via relative imports. There is no manual sync step.

### Website

The Hugo site deploys automatically via Netlify (`netlify.toml`). Build command:

```bash
cd website && hugo mod get && hugo --gc --minify
```

## Development conventions

- **Doc signing model**: Users sign Promise, Order, Tx, and Address docs. Banks sign Record and Offer docs. Account and Pocket docs have no `sig`. Do not add signatures to Account or Pocket.
- **Content-addressed docs**: Every doc (Promise, Account, Tx, Signature, etc.) is canonicalized, SHA-256-hashed, and stored/addressed by its base58 hash. References between docs use hashes, not surrogate IDs.
- **Bank scoping**: Every KV key is prefixed with the bank pubkey so one Deno KV database can serve multiple banks. Every query must include the prefix. Missing it is a bug.
- **Base58 everywhere**: Hashes, pubkeys, and signatures are stored as base58 strings. No binary types.
- **Exact balances**: Balances are stored as strings and computed with integer or decimal arithmetic; never use floating-point for ledger math.
- **Banks self-advance**: Clients only create records (`create_records`) and submit holder-signed Txs (`submit_tx`). From there each bank advances its own leg `created → approved → held → settled` event-driven — `advanceDeal()` re-evaluates on every `submit_tx` / `notify_signatures`, with no cron or background worker. Signatures travel between banks via subscription fan-out, with client relay (`barter nudge`) as the floor. `reject_deal` terminates from any pre-settled state.
- **Visibility boundary**: No bank ever sees another bank's records. A bank sees only the records of the promises it issues, the holder Txs that touch them, and the deal-level signatures of its peers.
- **Migration policy (v1)**: No in-place migrations after launch. If schema changes, wipe demo banks. v1.5 will introduce forward-compatible migrations.
- **Comments**: Load-bearing invariants are commented with `//` or `/* */` blocks. JSDoc is used for exported public APIs.
