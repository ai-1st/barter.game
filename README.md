# barter.game

A federated mutual-credit ledger. **Be your own bank.**

Mint a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked
dinner" — issued by you, signed by you, redeemable from you. Trade it with
people who know and trust you. The math binds you and them and the banks
together. No central authority. No middleman. Just signed promises and
their atomic settlement.

This is v1. It works end-to-end today.

## See it work

Two banks are live right now:

```
bank-alice  https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-alice
bank-bob    https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-bob
```

Hit either with `curl` and you'll get a signed `hello` proving its
identity. Run `./scripts/demo.sh` and you'll watch two simulated users
mint personal currencies on different banks, trade them, and settle.

```bash
git clone https://github.com/ai-1st/barter.game.git
cd barter.game
bun install
./scripts/demo.sh
```

The script narrates each step. By the end:

| Holder | Promise | Bank | Balance |
| --- | --- | --- | --- |
| Alice | "1 logo" | bank-alice (issuer) | **-1** (she gave it) |
| Bob   | "1 logo" | bank-alice | **+1** (he received) |
| Bob   | "1 hour" | bank-bob (issuer)   | **-1** (he gave it) |
| Alice | "1 hour" | bank-bob   | **+1** (she received) |

Sum per Promise = 0. The cryptographic version of "we're even."

## The big idea

For 40+ years, every "alternative currency" attempt (LETS, time banks,
mutual credit cooperatives) has run into the same wall: bootstrap. They
needed strangers to trust each other before the system was useful, and
strangers don't.

barter.game takes the opposite stance: **trust is local**. The system is
for people who already know each other and want to formalize their
trades. Friends, freelancer collaborators, club members, event attendees.
The protocol gives the existing trust a verifiable surface — signed
receipts, atomic settlement, no ambiguity about who owes whom.

That single re-framing — "settlement layer for existing trust, not a
marketplace for strangers" — is what makes the protocol simple enough to
build on a weekend cadence. No reputation system. No dispute resolution.
No clearing house. Just cryptography and the social contract you
already have.

See [`ETHOS.md`](./ETHOS.md) for the full set of beliefs.

## What's in this repo

```
barter.game/
├── ETHOS.md              ← the beliefs driving the design
├── PROTOCOL.md           ← the v1 wire-format spec
├── SCHEMA.md             ← database tables, columns, invariants
├── TODOS.md              ← the v1.5+ roadmap
├── packages/protocol/    ← the @barter.game/protocol library (canonical, crypto, schemas, invites)
├── apps/cli/             ← the `barter` CLI: init, mint, open, trade, confirm, settle, inbox
├── supabase/
│   ├── migrations/       ← SQL schema (see SCHEMA.md)
│   └── functions/
│       ├── _shared/      ← shared bank code (rpc, handlers, db, peer)
│       ├── bank-alice/   ← one Edge Function per bank
│       └── bank-bob/
├── scripts/
│   ├── demo.sh           ← the full v1 demo
│   ├── genkey.ts         ← generate an ed25519 keypair for a new bank
│   └── sync-protocol.ts  ← copy protocol code into Edge Function _shared/
└── docs/legacy/          ← the original notes that informed v1
```

## Using the CLI

```bash
# One-time setup
barter init --bank https://...your-bank.../functions/v1/bank-alice

# Issue a personal currency
barter mint "1 logo" --integer

# Prepare to receive someone else's currency
barter open <their-promise-hash> --bank <their-bank-url>

# Propose a cross-bank trade
barter trade \
  --give <my-promise>:1 --get <their-promise>:1 \
  --my-give-account <h> --peer-give-account <h> \
  --peer-get-account <h> --my-get-account <h> \
  --peer-pubkey <pubkey> --peer-bank <url>

# After both sides confirm, lead user settles
barter confirm <tx-hash>
barter settle <tx-hash>

# See your balances
barter inbox
barter inbox --bank <other-bank-url>
```

Every command shows you the hashes, signatures, and state transitions.
The CLI is the protocol's truest surface; the web UI ships in v1.5.

## How the protocol works (one paragraph)

Every user and every bank is an ed25519 keypair. Every doc — Promise,
Pocket, Account, Tx, Record, Signature — is canonicalized via RFC 8785
JSON, SHA-256-hashed, and content-addressed by that hash. Every RPC is a
signed JSON-RPC envelope binding the request to (sender, recipient,
ULID). A cross-bank trade walks `propose → approve → hold → confirm →
settle` across two banks; the lead bank settles first, then notifies the
follow bank, which settles too. The lead bank carries the small remaining
risk that the follow bank goes rogue; per the ETHOS, that risk is settled
socially, not by protocol-level rollback.

Full details in [`PROTOCOL.md`](./PROTOCOL.md).

## How to run your own bank

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

You now have a bank. Tell your friends about it. They run `barter init`
against your URL and you're a tiny central bank in a federation of
exactly however many people you've invited.

## Tests

```bash
bun run test:all
```

75 tests: 61 under Bun, 14 under Deno. The Deno suite re-runs the same
canonical-JSON golden vectors under a different runtime. Cross-runtime
parity is the load-bearing invariant — every signature in the protocol
depends on it.

## What v1 doesn't do

Honest list:

- **No web UI.** CLI only.
- **No protocol-level rollback.** If the follow bank goes rogue after
  the lead settles, the lead is out. Recourse is social.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No N-bank trades.** v1 caps at 2 banks per Tx.
- **No NFT-like Promises.** Issued Promises are fungible.
- **No automatic forward-confirm retry.** Best-effort.
- **No cross-bank inbox aggregation.** `barter inbox` hits one bank.

These are documented limitations, not bugs. See [`TODOS.md`](./TODOS.md)
for the v1.5+ work.

## Reading order if you're new here

1. [`ETHOS.md`](./ETHOS.md) — what we believe, why we built it this way (10 minutes)
2. [`./scripts/demo.sh`](./scripts/demo.sh) — see it work (5 minutes)
3. [`PROTOCOL.md`](./PROTOCOL.md) — the wire-format contract (45 minutes if you read carefully)
4. [`SCHEMA.md`](./SCHEMA.md) — the database layer (15 minutes)
5. `packages/protocol/src/` — the code (an afternoon)
6. `supabase/functions/_shared/bank/handlers/` — the server-side state machine
7. [`TODOS.md`](./TODOS.md) — what's next

## License

MIT (planned; license file lands with the v1 public release).

## Contributing

This is early. The protocol is small enough to keep in your head. If you
find a bug, mismatch between the spec and the code, or a place where
the ETHOS got compromised — open an issue, and bring receipts.
