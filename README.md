# barter.game

A federated mutual-credit ledger. Be your own bank.

## What's live (v1)

Two banks deployed on Supabase, multi-tenant Postgres backing both. Real ed25519-signed JSON-RPC. Real cross-bank `propose → approve → hold → confirm → settle` end-to-end, with the lead/follow risk model from the design doc.

- **bank-alice** — `https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-alice` (pubkey `FHkPndqnmsjkgUQfFPdeNmLQ8zy8yeGf99LELUJzKUYE`)
- **bank-bob** — `https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-bob` (pubkey `3cHkSsLHwGpfcX3GcnV7b9vmrajtqPXxXwXVyFYGy6YD`)

## Run the demo

```bash
git clone https://github.com/ai-1st/barter.game.git
cd barter.game
bun install
./scripts/demo.sh
```

This script provisions two fresh CLI profiles (Alice, Bob), mints a Promise on each bank, opens mutual accounts, runs a cross-bank trade, and shows the resulting balances. Output is human-readable and self-narrating.

End state of the demo trade:

| Holder | Promise | Bank | Balance |
| --- | --- | --- | --- |
| Alice | "1 logo" | bank-alice (issuer) | **-1** |
| Bob | "1 logo" | bank-alice | **+1** |
| Bob | "1 hour" | bank-bob (issuer) | **-1** |
| Alice | "1 hour" | bank-bob | **+1** |

Sum per promise = 0. The math binds the two banks together.

## Architecture

```
                  Alice's CLI                               Bob's CLI
                  ----------                                --------
                  ed25519 keys                              ed25519 keys
                  ~/.barter/profile.json                    ~/.barter/profile.json
                       │                                          │
                       │ signed JSON-RPC                          │ signed JSON-RPC
                       ▼                                          ▼
       ┌───────────────────────┐                  ┌───────────────────────┐
       │  bank-alice           │                  │  bank-bob             │
       │  Edge Function (Deno) │ ◄── peer RPC ──► │  Edge Function (Deno) │
       │  BANK_ALICE_PRIV_KEY  │                  │  BANK_BOB_PRIV_KEY    │
       └───────────────────────┘                  └───────────────────────┘
                       │                                          │
                       └────────────┬─────────────────────────────┘
                                    ▼
                       Supabase Postgres (multi-tenant)
                       docs, accounts, holds, txs, replay_window, bank_peers
                       Every row scoped by `bank_pubkey`.
```

## Repo layout

```
barter.game/
├── packages/protocol/             @barter.game/protocol (canonical, crypto, schemas, invite)
├── apps/cli/                      barter CLI (init, mint, open, trade, confirm, settle, inbox)
├── supabase/
│   ├── config.toml
│   ├── migrations/                docs + accounts + holds + txs + replay_window + bank_peers
│   └── functions/
│       ├── _shared/
│       │   ├── protocol/          (synced from packages/protocol/src via scripts/sync-protocol.ts)
│       │   └── bank/              db, rpc envelope, handlers, peer client
│       ├── bank-alice/index.ts
│       └── bank-bob/index.ts
├── scripts/
│   ├── genkey.ts                  generate an ed25519 keypair for a new bank
│   ├── sync-protocol.ts           sync protocol code into _shared/ before deploy
│   └── demo.sh                    the full v1 demo (mint → open → trade → settle)
├── docs/legacy/                   original protocol notes
└── TODOS.md                       v1.5+ deferred items
```

## CLI reference

```
barter init --bank <url>
barter mint <name> [--integer] [--due YYYY-MM-DD] [--limit N]
barter open <promise-hash> --bank <issuer-url> [--pocket <hash>]
barter trade --give <hash>:N --get <hash>:N \
             --my-give-account <h> --peer-give-account <h> \
             --peer-get-account <h> --my-get-account <h> \
             --peer-pubkey <pubkey> --peer-bank <url>
barter confirm <tx-hash> [--bank <url>]
barter settle <tx-hash>
barter inbox [--bank <url>]
```

## Test the protocol package

```bash
bun install
bun run test:all              # 61 Bun tests + 14 Deno tests, cross-runtime canonical JSON parity
```

## Deploy your own bank

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push                                       # apply migrations
bun run scripts/genkey.ts | sed 's/BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
supabase secrets set --env-file /tmp/key.env && rm /tmp/key.env
bun run scripts/sync-protocol.ts                       # copy shared protocol code
supabase functions deploy bank-alice --no-verify-jwt
```

## v1 limitations (read before building on this)

- **No protocol-level rollback.** Lead/follow risk model — if follow abandons after lead settles, lead is out. Social recourse only.
- **No key recovery.** Lose your key, lose your account.
- **No key rotation.** Bank keys and user keys are forever in v1.
- **No cross-bank inbox aggregation.** Each `barter inbox` hits one bank at a time.
- **CLI-only.** Web UI is a v1.5 deliverable.
- **`barter doctor` not yet implemented.** Lands in v1.5 per TODOS.md.
- **Two-CLI integration test harness not yet wired.** Manual end-to-end via `scripts/demo.sh`.

## Design doc

`~/.gstack/projects/barter.game/xo-main-design-20260526-145322.md` (Status: APPROVED).

## License

MIT (planned; license file lands with v1 release).
