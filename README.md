# barter.game

A federated mutual-credit ledger. Be your own bank.

Status: **Weekend 1** of the v1 build (see `~/.gstack/projects/barter.game/xo-main-design-20260526-145322.md`).

## What ships in this commit (W1)

- **`packages/protocol`** — pure-TS protocol library. No I/O.
  - `canonical.ts` — RFC 8785 JSON canonicalization. Hand-rolled, no npm-shim drift between Deno and Bun.
  - `crypto.ts` — ed25519 sign/verify, base58 encode/decode, SHA-256, ULIDs, hash-and-sign helpers.
  - `schemas.ts` — `Promise`, `Pocket`, `Account`, `Record`, `Tx`, `Signature` types + runtime validators.
  - `invite.ts` — `barter://` invite string format with self-validating signatures.
- **`apps/cli`** — `barter` CLI skeleton (`--help`, `--version`, command stubs for W2+).
- **`supabase/`** — Edge Function scaffold + `bank-alice` Hello World that loads its private key from `BANK_ALICE_PRIV_KEY`, publishes its pubkey at `/.well-known/barter-bank.json`, and signs a challenge on `GET /`.
- **Cross-runtime canonical-JSON test** — 13 golden vectors that pass under both Bun (`vitest`-style) AND Deno (`Deno.test`). This is the load-bearing parity test the eng review flagged as W1's hard deliverable.

## Repo structure

```
barter.game/
├── packages/
│   └── protocol/                # @barter.game/protocol
│       ├── src/
│       │   ├── canonical.ts
│       │   ├── crypto.ts
│       │   ├── schemas.ts
│       │   ├── invite.ts
│       │   └── index.ts
│       ├── test/                # Bun-side tests
│       └── test-deno/           # Deno-side parity tests
├── apps/
│   └── cli/                     # barter CLI
├── supabase/
│   ├── config.toml
│   ├── functions/
│   │   └── bank-alice/          # Hello World Edge Function
│   └── .env.local               # Local dev secrets (gitignored)
├── scripts/
│   └── genkey.ts                # ed25519 keypair generator
├── docs/legacy/                 # Original protocol notes
└── TODOS.md                     # v1.5+ deferred items
```

## Test the protocol package

```bash
bun install
bun test                              # 61 tests pass (Bun-side)
bun run test:deno                     # 14 tests pass (Deno-side, same fixtures)
bun run test:all                      # both
```

## Run bank-alice locally (without Docker / Supabase CLI)

```bash
# Generate a bank private key and stash it in .env.local
bun run scripts/genkey.ts | sed 's/BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > supabase/.env.local

# Serve the Edge Function directly under Deno (faster than `supabase functions serve`)
export BANK_ALICE_PRIV_KEY=$(grep BANK_ALICE_PRIV_KEY supabase/.env.local | cut -d= -f2)
deno run --allow-env --allow-net --allow-read supabase/functions/bank-alice/index.ts

# Probe it
curl http://127.0.0.1:8000/
curl http://127.0.0.1:8000/.well-known/barter-bank.json
```

## Deploy bank-alice to a real Supabase project

```bash
supabase login
supabase link --project-ref <your-project-ref>

# Set the bank's private key as a project secret
bun run scripts/genkey.ts | sed 's/BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/bank-alice.env
supabase secrets set --env-file /tmp/bank-alice.env
rm /tmp/bank-alice.env

supabase functions deploy bank-alice
```

After deploy, the function is at `https://<project-ref>.supabase.co/functions/v1/bank-alice/`.

## What's next (W2)

Per the design doc: SQL migrations for `docs`, `accounts`, `holds`, `replay_window`; `mint_promise`, `open_account`, same-bank `propose_trade → approve → hold → settle`; CLI commands for `barter mint`, `barter open`, `barter trade` (same-bank path).

## v1 constraints (read before you build on this)

- No protocol-level rollback. Lead/follow risk model — if follow abandons, lead is out, social recourse only.
- No key recovery. Lose your key, lose your account.
- CLI-only client surface in v1. Web UI is v1.5.
- 5-7 weekends to ship the full v1 protocol; see the design doc's "Next Steps" section.

## License

MIT (planned; license file lands with v1 release in W6).
