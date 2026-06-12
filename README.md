# barter.game

A federated mutual-credit ledger. **Be your own bank.**

Mint a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked
dinner" — issued by you, signed by you, redeemable from you. Trade it with
people who know and trust you. The math binds you and them and the banks
together. No central authority. No middleman. Just signed promises and
their atomic settlement.

This is v1. It works end-to-end today.

## See it work

Four demo banks are live right now:

```
bank-alice  https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-alice
bank-bob    https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-bob
bank-carol  https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-carol
bank-dave   https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-dave
```

Hit any with `curl` and you'll get a signed `hello` proving its
identity. Run `./scripts/demo.sh` and you'll watch four simulated users
on four different banks mint personal currencies, initiate a multi-party
deal, accept their deal tokens — and then watch the banks settle it
on their own, in topological order.

```bash
git clone https://github.com/ai-1st/barter.game.git
cd barter.game
bun install
./scripts/demo.sh
```

The script narrates each step. By the end every Promise that moved
sums to zero across all its accounts — the cryptographic version of
"we're even." For a simple bilateral swap the balances look like this:

| Holder | Promise | Bank | Balance |
| --- | --- | --- | --- |
| Alice | "1 logo" | bank-alice (issuer) | **-1** (she gave it) |
| Bob   | "1 logo" | bank-alice | **+1** (he received) |
| Bob   | "1 hour" | bank-bob (issuer)   | **-1** (he gave it) |
| Alice | "1 hour" | bank-bob   | **+1** (she received) |

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
├── SETTLEMENT_WALKTHROUGH.md ← the canonical narrative of one trade — start here
├── ETHOS.md              ← the beliefs driving the design
├── PROTOCOL.md           ← the INVARIANT protocol contract (read this if building your own)
├── IMPLEMENTATION.md     ← how *this repo* implements v1 (change anything here for your stack)
├── SCHEMA.md             ← v1 reference database schema
├── TODOS.md              ← the v1.5+ roadmap
├── packages/protocol/    ← the @barter.game/protocol library (canonical, crypto, schemas, invites, deal tokens)
├── apps/cli/             ← the `barter` CLI: init, mint, account, invite, trade, deal, accept, status, nudge, subscribe, inbox
├── supabase/
│   ├── migrations/       ← SQL schema (see SCHEMA.md)
│   └── functions/
│       ├── _shared/      ← shared bank code (rpc, handlers, advance engine, subscriptions, db)
│       ├── bank-alice/   ← one Edge Function per bank
│       ├── bank-bob/
│       ├── bank-carol/
│       └── bank-dave/
├── scripts/
│   ├── demo.sh           ← the full v1 demo
│   ├── genkey.ts         ← generate an ed25519 keypair for a new bank
│   └── sync-protocol.ts  ← copy protocol code into Edge Function _shared/
├── docs/legacy/          ← the original notes that informed v1
└── website/              ← Hugo/Hextra static site (see below)
```

## Using the CLI

```bash
# One-time setup
barter init --bank https://...your-bank.../functions/v1/bank-alice

# Issue a personal currency — the mint IS the first ledger record pair
# (your issue account goes to -5, your holding account to +5)
barter mint "1 logo" --amount 5 --integer

# Offer a swap: prints a signed barter:// invite string for the counterparty
# (accounts are implicit — no bank call to "open" anything)
barter invite --give <my-promise>:1 --get <their-promise>:1

# Counterparty initiates from the invite: creates records on both banks,
# lead-signs their own Tx, and prints a deal token back for you
barter trade --invite "barter://..."

# You verify and follow-sign your own Tx — from here the banks
# self-advance through hold and settle; nobody drives settlement
barter accept "barterdeal:..."

# Or initiate an N-party deal from a JSON file (one deal token per holder)
barter deal <deal-file.json>

# Watch a deal you initiated; relay signatures by hand if a push got lost
barter status <deal-ulid>
barter nudge <deal-ulid>

# See your balances
barter inbox
barter inbox --bank <other-bank-url>
```

Every command shows you the hashes, signatures, and state transitions.
The CLI is the protocol's truest surface; the web UI ships in v1.5.

## How the protocol works (one paragraph)

Every user and every bank is an ed25519 keypair. Promise, Pocket,
Account, Signature, and Order docs are canonicalized via RFC 8785 JSON,
SHA-256-hashed, and content-addressed by that hash. Accounts are
implicit — they come into existence when an Account doc is first
presented, and Pocket bodies never leave the holder (banks only ever
see the hash). Ledger records are bank-minted in mandatory debit/credit
pairs; the mint itself is just the first such pair. Each holder signs
their OWN `Tx` — the record ULIDs on their own accounts — with action
`lead` (the initiator) or `follow` (everyone else); banks answer with
per-record `approve`/`reject` signatures. From there the banks
self-advance: each one holds its debit accounts, the lead bank settles
once it has seen every peer's `hold`, and followers settle after their
predecessors, citing the upstream settle proofs in `Signature.seen`.
Signatures travel between banks via Subscription fan-out, or any party
relays them by hand (`barter nudge`) — they carry their own authority.
The lead banks carry the small remaining risk that a follower goes
rogue; per the ETHOS, that risk is settled socially, not by
protocol-level rollback.

Full details in [`PROTOCOL.md`](./PROTOCOL.md); the story version is
[`SETTLEMENT_WALKTHROUGH.md`](./SETTLEMENT_WALKTHROUGH.md).

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

127 tests: 103 under Bun, 24 under Deno. The Deno suite re-runs the
same canonical-JSON golden vectors under a different runtime, then
exercises the full bank: minting, the bilateral direct-approval
walkthrough, subscription fan-out, and a four-bank N-party deal in
which the banks self-advance to settled. Cross-runtime parity is the
load-bearing invariant — every signature in the protocol depends on it.

## What v1 doesn't do

Honest list:

- **No web UI.** CLI only.
- **No protocol-level rollback.** If a follow bank goes rogue after
  the lead settles, the lead is out. Recourse is social.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Promises.** Issued Promises are fungible.
- **No guaranteed push delivery.** Subscription fan-out is
  fire-and-forget; a lost push stalls a deal until `barter nudge`
  relays the signatures by hand.
- **No cross-bank inbox aggregation.** `barter inbox` hits one bank.

These are documented limitations, not bugs. See [`TODOS.md`](./TODOS.md)
for the v1.5+ work.

## Reading order if you're new here

1. [`SETTLEMENT_WALKTHROUGH.md`](./SETTLEMENT_WALKTHROUGH.md) — the canonical narrative: Alice, Bob, two banks, one trade (10 minutes)
2. [`ETHOS.md`](./ETHOS.md) — what we believe, why we built it this way (10 minutes)
3. [`./scripts/demo.sh`](./scripts/demo.sh) — see it work (5 minutes)
4. [`PROTOCOL.md`](./PROTOCOL.md) — the **invariant protocol contract** (45 minutes if you read carefully)
5. [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) — how *we* built it; change anything here for your own stack (30 minutes)
6. [`SCHEMA.md`](./SCHEMA.md) — the v1 reference database layer (15 minutes)
7. `packages/protocol/src/` — the code (an afternoon)
8. `supabase/functions/_shared/bank/` — the server-side handlers and advance engine
9. [`TODOS.md`](./TODOS.md) — what's next

## Building your own implementation?

Read [`PROTOCOL.md`](./PROTOCOL.md) cover to cover. That is the contract. Everything else — Supabase, Edge Functions, Postgres, the CLI, even TypeScript — is a choice we made that you are free to swap out. [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) explains our choices so you can learn from them or ignore them. The protocol doesn't care if your bank is written in Rust, Go, or Python, as long as the wire format and invariants match.

## License

MIT (planned; license file lands with the v1 public release).

## Contributing

This is early. The protocol is small enough to keep in your head. If you
find a bug, mismatch between the spec and the code, or a place where
the ETHOS got compromised — open an issue, and bring receipts.
