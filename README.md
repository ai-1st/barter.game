# barter.game

A federated mutual-credit ledger. **Be your own bank.**

Mint a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked
dinner" — issued by you, signed by you, redeemable from you. Trade it with
people who know and trust you. The math binds you and them and the banks
together. No central authority. No middleman. Just signed vouchers and
their atomic settlement.

This is v1. It works end-to-end today.

## See it work

Four demo banks are live right now on Deno Deploy:

```
bank-alice  https://barter-game-banks.ai-1st.deno.net/alice
bank-bob    https://barter-game-banks.ai-1st.deno.net/bob
bank-carol  https://barter-game-banks.ai-1st.deno.net/carol
bank-dave   https://barter-game-banks.ai-1st.deno.net/dave
```

Hit the root with `curl` and you'll see the four live banks; hit
`/:name/barter-bank.json` for a bank's discovery document.

Run the demo against them:

```bash
git clone https://github.com/ai-1st/barter.game.git
cd barter.game
bun install
export BARTER_BANK_ALICE_URL=https://barter-game-banks.ai-1st.deno.net/alice
export BARTER_BANK_BOB_URL=https://barter-game-banks.ai-1st.deno.net/bob
export BARTER_BANK_CAROL_URL=https://barter-game-banks.ai-1st.deno.net/carol
export BARTER_BANK_DAVE_URL=https://barter-game-banks.ai-1st.deno.net/dave
./scripts/demo-deploy.sh
```

The script narrates each step. By the end every Voucher that moved
sums to zero across all its accounts — the cryptographic version of
"we're even." For a simple bilateral swap the balances look like this:

| Holder | Voucher | Bank | Balance |
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
├── protocol/             ← the INVARIANT protocol contract (read these if building your own)
├── IMPLEMENTATION.md     ← how *this repo* implements v1 (change anything here for your stack)
├── SCHEMA.md             ← v1 reference database schema
├── TODOS.md              ← the v1.5+ roadmap
├── old/                  ← archived implementation while the protocol is being reworked
│   ├── apps/
│   │   ├── cli/          ← the `barter` CLI (archived; will be rebuilt)
│   │   └── bank/         ← the Deno Deploy bank server (archived; will be rebuilt)
│   ├── packages/protocol/← the @barter.game/protocol library (archived)
│   └── supabase/         ← SQL schema kept for reference
├── scripts/
│   ├── demo-deploy.sh    ← full v1 demo against live Deno Deploy banks
│   ├── demo-local.sh     ← same demo against a locally started bank server
│   └── genkey.ts         ← generate an ed25519 keypair for a new bank
├── docs/legacy/          ← the original notes that informed v1
└── website/              ← Hugo/Hextra static site (see below)
```

## Using the CLI

The v1 CLI is archived in `old/apps/cli/` while the protocol is being
reworked. It will be rebuilt against the new `protocol/` contract. The
demo scripts below still exercise the live Deno Deploy banks using the
old implementation.

```bash
# One-time setup
barter init --bank https://barter-game-banks.ai-1st.deno.net/alice

# Issue a personal currency by placing an issuer sell-Order
barter order --sell "1 logo" --amount 5 --integer

# Offer a swap: prints a signed barter:// invite string for the counterparty
barter invite --give <my-voucher>:1 --get <their-voucher>:1

# Counterparty initiates from the invite: creates records on both banks
# and prints a deal token back for you
barter trade --invite "barter://..."

# You verify and sign — from here the banks self-advance
barter accept "barterdeal:..."

# Watch a deal; relay signatures by hand if a push got lost
barter status <deal-ulid>
barter nudge <deal-ulid>

# See your balances
barter inbox
barter inbox --bank <other-bank-url>
```

Every command shows you the hashes, signatures, and state transitions.
The CLI is the protocol's truest surface; the web UI ships in v1.5.

## How the protocol works (one paragraph)

Every user and every bank is an ed25519 keypair. Voucher, Account,
Signature, and Order docs are canonicalized via RFC 8785 JSON,
SHA-256-hashed, and content-addressed by that hash. Accounts are signed
by their holder and stored by the bank; the account name stays private,
but the bank needs the Account doc to verify that a Record's account
hash belongs to the record's holder. There is no mint: an issuer starts
trading by placing an Order that debits its own issuer account, driving
it negative. Ledger records are bank-minted in mandatory debit/credit
pairs. A matchmaker discovers compatible Offers and calls
create_records on each participating bank, then sends each bank a
per-bank Confirm listing the records it should act on. Once a record
has a valid Order bound and the Confirm is received, the bank's advance
engine takes over: it issues ready, locks the debit account with hold,
and settles once preconditions are met. Settle signatures for follower
records cite the upstream settle proofs in `Signature.seen`.
Signatures travel between banks via Subscription fan-out, or any party
relays them by hand — they carry their own authority.

Full details in [`protocol/README.md`](./protocol/README.md) and the split contract files; the story version is
[`MASTER-INPUT.md`](./MASTER-INPUT.md).

## How to run your own bank

The reference bank is a single Deno Deploy service. One process can serve
any number of named banks; each bank's private key comes from its own
`BANK_<NAME>_PRIV_KEY` environment variable.

```bash
# 1. Clone the repo and install
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install

# 2. Generate a bank private key
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
#    Repeat for each bank you want to serve (BANK_BOB_PRIV_KEY, ...).

# 3. Create a Deno Deploy project at https://deno.com/deploy
#    - Link this repo
#    - Set environment variables from /tmp/key.env
#    - Entrypoint: old/apps/bank/main.ts
#    The included .github/workflows/deploy.yml auto-deploys on every push to main.

# 4. Hit it
curl https://<your-project>.deno.dev/
```

You now have a bank. Tell your friends about it. They run `barter init`
against your URL and you're a tiny central bank in a federation of
exactly however many people you've invited.

See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §4 for the full deployment
and operational details.

## Tests

```bash
bun run test:all
```

The suite runs the archived protocol library under Bun, then re-runs the
same canonical-JSON golden vectors plus full bank integration scenarios
under Deno. Cross-runtime parity is the load-bearing invariant — every
signature in the protocol depends on it.

## What v1 doesn't do

Honest list:

- **No web UI.** CLI only.
- **No protocol-level rollback.** If a follow bank goes rogue after
  the lead settles, the lead is out. Recourse is social.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Vouchers.** Issued Vouchers are fungible.
- **No guaranteed push delivery.** Subscription fan-out is
  fire-and-forget; a lost push stalls a deal until `barter nudge`
  relays the signatures by hand.
- **No cross-bank inbox aggregation.** `barter inbox` hits one bank.

These are documented limitations, not bugs. See [`TODOS.md`](./TODOS.md)
for the v1.5+ work.

## Reading order if you're new here

1. [`SETTLEMENT_WALKTHROUGH.md`](./SETTLEMENT_WALKTHROUGH.md) — the canonical narrative: Alice, Bob, two banks, one trade (10 minutes)
2. [`ETHOS.md`](./ETHOS.md) — what we believe, why we built it this way (10 minutes)
3. [`./scripts/demo-deploy.sh`](./scripts/demo-deploy.sh) — see it work against live banks (5 minutes)
4. [`protocol/README.md`](./protocol/README.md) — the **invariant protocol contract overview**, then `protocol/base.md`, `protocol/bank-schema.md`, and `protocol/bank-rpc.md` (45 minutes if you read carefully)
5. [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) — how *we* built it; change anything here for your own stack (30 minutes)
6. [`SCHEMA.md`](./SCHEMA.md) — the v1 reference database layer (15 minutes)
7. `old/packages/protocol/src/` — the archived reference code
8. `old/apps/bank/` — the archived server-side handlers and advance engine
9. [`TODOS.md`](./TODOS.md) — what's next

## Building your own implementation?

Read [`protocol/README.md`](./protocol/README.md) cover to cover, then the split contract files (`protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`). That is the contract. Everything else — Deno Deploy, Deno KV, the CLI, even TypeScript — is a choice we made that you are free to swap out. [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) explains our choices so you can learn from them or ignore them. The protocol doesn't care if your bank is written in Rust, Go, or Python, as long as the wire format and invariants match.

## License

MIT (planned; license file lands with the v1 public release).

## Contributing

This is early. The protocol is small enough to keep in your head. If you
find a bug, mismatch between the spec and the code, or a place where
the ETHOS got comvoucherd — open an issue, and bring receipts.
