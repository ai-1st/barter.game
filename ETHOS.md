# Ethos

> **Why "game"?** barter.game is designed as a game first. We suggest treating it as a practice environment for trading skills — a safe space to experiment with personal currencies, negotiation, and settlement. Only use it for real economic transactions if your local laws and circumstances permit. The "game" framing keeps the stakes appropriate while the protocol itself is serious cryptography.

The beliefs driving barter.game. These are not requirements written into the
spec; they are the priors that shape every decision when the spec runs out.

## 1. Be your own bank

The fantasy is older than money: you, sovereign, issuing your own currency
backed by something you can deliver. Not a token wrapping a stablecoin. Not a
loyalty point. A signed voucher — "1 logo, by Alice, due on demand." Yours.
You decide how many exist. You decide who gets them. You decide what they
cost.

The system exists to make this fantasy practical, not theoretical. Anyone
with a cloud account or own server can deploy a bank. Anyone with a
keyboard can mint a voucher.

## 2. Trust is local; the protocol formalizes it

barter.game does NOT solve trust between strangers. It is a tool for people
who *already* trust each other and want to make their dealings precise. The
designer trading "1 logo" for "1 day of dev work" already has a relationship
with the developer. The friend group running an IOU system already knows
who's good for the round. The protocol records the deal; it does not
adjudicate it.

When we had to choose between "build a marketplace where strangers find
each other" and "build a settlement layer for people who already know each
other," we chose the latter without flinching. The protocol ships discovery
surfaces — registries, offers, QR profiles, voucher feeds
([`protocol/discovery.md`](./protocol/discovery.md)) — but they distribute
*facts*, not trust. Reputation is out of band. The protocol's job is to give
the existing trust a verifiable surface — signed receipts, atomic ledger
updates, no ambiguity about who owes whom.

## 3. Who trusts whom — and for what

The trust topology is small and asymmetric, and every design decision leans
on it:

- **Holders trust issuers — for redemption.** A voucher is worth what its
  issuer will actually deliver. Nothing else backs it.
- **Holders trust banks — for settlement.** The bank keeps the ledger
  honest: one hold per account, sum-to-zero on every settle, signatures on
  every step.
- **Holders never need to trust other holders.** Settlement is fully done
  by the banks; the counterparty holder is interchangeable. This is why
  Offers hide holder identity, and why you can trade with a stranger at an
  event as long as you trust the voucher's issuer and the issuer's bank.

## 4. Mutual credit, not currency

When Alice mints "1 logo," she does not pre-fund anything. Her account at
her bank simply records `-1` — she owes the network one logo. When she
delivers, the holder's balance and her balance both move toward zero. The
sum across all accounts for any voucher is always zero (or the agreed-on
limit). This is the LETS pattern, four decades old, with one cryptographic
upgrade: every step is signed.

We do not pretend personal currencies are money. They circulate among
people who hold the issuer accountable, and they die when the issuer
stops being accountable. That's the correct lifecycle.

## 5. Value is local too

Voucher value is not universal — and that's a feature, not a bug. A voucher
for a free haircut in Tokyo is worthless to someone who is never going to
Tokyo, no matter how impeccably it settles. If such a voucher lands in your
account (say, donated), the rational move is to trade it toward something
you *can* redeem — a pizza in your own city.

This is why the protocol has no global price oracle and no canonical
exchange rate: worth is decided between the two people signing the Orders,
every time. A market where every price is bilateral isn't a primitive
market; it's an honest one.

## 6. The settlement layer only needs as much trust as the vouchers

Traditional crypto blockchains provide an ultra-reliable settlement layer —
and users still have to trust the token issuer for the token's value and
redeemability. If somebody issues a voucher for "a beer with me," it is nice
to have holder rights protected by a globally distributed blockchain, but
what's the use of those rights if the issuer no longer drinks beer, or the
holder sees no value in a beer with the grumpy old man the issuer has turned
into?

The redemption promise is always the weakest link. So the settlement layer
needs only the *same* level of reliability and trust as the vouchers it
settles — and a bank run by the issuer's community clears that bar without
a proof-of-work in sight. Engineering settlement reliability far past the
reliability of the promises being settled is wasted engineering.

## 7. The issuer picks the bank — and answers for it

Every voucher names its bank; choosing it is the issuer's call, and so is
the fallout. If the bank goes offline or loses records, that is ultimately
the **issuer's reputation problem** — the holders know the issuer
personally; they don't necessarily know the bank operator. The issuer
apologizes to their holders and re-issues the vouchers at another bank from
the most recent backup.

The protocol makes that recovery real, not aspirational: a bank MUST let an
issuer fetch every record, detail, and signature for the vouchers they
issue (`list_voucher_records`, [`protocol/bank-rpc.md`](./protocol/bank-rpc.md) §2.4),
so a diligent issuer always holds enough signed evidence to reconstruct
holder positions elsewhere.

## 8. Lead and follow — social risk over protocol risk

When Alice and Bob trade across two banks, *someone* settles first. The
party that settles first carries the risk: if the other party abandons,
the first one is out. We could have built a multi-phase commit with
timeouts and signed rollbacks and partition-tolerance reconciliation. We
chose not to.

Why: the failure mode that protocol-level rollback prevents — "bank A
settled but bank B never did" — is a *bank*-level failure, not a *user*-
level failure. Users already signed the deal. The remaining risk is one
bank being uncooperative. In our trust
model (operators are known to their users), that risk is settled socially:
the lead party yells at the issuer of the voucher not being delivered,
issuer yells at their bank operator, whom they presumably
know in person.

Distributed atomicity is the right answer for systems where the operators
are strangers. We are not that system.

## 9. No expirations — forever docs, no clock sync

The protocol deliberately avoids expirations, timeouts, and any mechanism that
requires synchronized clocks across participants.

- **All signatures and documents are irrevocable and eternal.** Once signed, a
doc lives forever in the content-addressed graph. There is no revocation
mechanism, no "cancel this signature" operation, and no TTL.
- **Standing orders are forever — and they are the authorization.** An
`Order` (see [`protocol/bank-schema.md`](./protocol/bank-schema.md) §1.4) is a signed
instruction that authorizes the bank to process matching records on the
holder's behalf. Having placed it, the holder can go offline: **banks settle
autonomously**, advancing deals as signatures arrive, with no holder
interaction at settlement time. An Order remains valid for as long as the
holder maintains sufficient balance in the relevant account. The only limit
is the account itself.
- **Cancellation is mechanical, not administrative.** A holder who wants to stop
offering a voucher empties the corresponding account. A bank that refuses a
record issues a `reject` signature on the record(s); releasing a hold without
settling is a `reject` over the deal. Both become part of the public audit
trail.
- **No clock synchronization.** Removing time-based expiry eliminates an entire
class of distributed-system bugs: clock skew, NTP failures, timezone confusion,
and race conditions around boundary timestamps. The only ordering guarantee is
the partial order established by `Signature.seen`.

This is a trade-off. It means abandoned holds must be cleaned up by operator
sweepers (a hygiene convenience, not a correctness mechanism) and that users
must manage their own exposure through account balance, not through time-boxed
authorizations. (The only dates the schema carries are `Voucher.due` and
`Voucher.expires` — an issuer's declarations about the *promise*, not
protocol timeouts.)

## 10. Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks
talk to each other via signed HTTP. Anyone running the codebase can be
a peer. The demo collapses several banks into one Deno Deploy process and
one Deno KV database for operational simplicity; the *protocol* doesn't
know or care. A fifth bank can join tomorrow.

If barter.game ever centralized — even subtly, even for "the demo" — we
have built the wrong thing.

## 11. Content-addressed docs — almost all the way down

Voucher, Account, Order, and Signature docs are hashed by their
canonical JSON form. References between these docs use those hashes.
Nothing has an ID assigned by a server. Two banks that store the same
Voucher doc store it under the same hash. Audit means walking the hash
graph; verification means re-hashing. Banks store the docs presented to
them; the artifacts a bank creates are ledger records, signatures, and
the derived statements it publishes from them (Offers, Balance
attestations).

**Ledger records are the exception.** A record is minted by the
bank that issues it, assigned a ULID by that bank, and referenced by
ULID — not by content hash. The same logical transfer executed twice
will produce different record ULIDs, so the records are not content-
addressed. This trade-off makes the bank the sole authority for its
ledger entries and eliminates a class of client-side hash-mismatch bugs.
The cross-runtime canonical JSON parity test remains load-bearing for
everything that IS content-addressed.

## 12. Discovery without a marketplace

Staying out of the matchmaking business doesn't mean staying mute. The
protocol supports exactly the discovery a trust-local network needs
([`protocol/discovery.md`](./protocol/discovery.md)):

- Check a bank's public registry of vouchers, optionally filtered by issuer.
- Scan an issuer's QR and get their key plus the vouchers — registry-listed
  or not — they chose to bundle into it.
- Read posts from issuers you trust; when they recommend other issuers or
  vouchers, decide for yourself whether to extend trust
  ([`protocol/post-feed.md`](./protocol/post-feed.md)).
- Learn from a scanned QR that X holds Y vouchers from Z — backed by
  bank-signed Balance docs on accounts X chose to make public — and decide
  to get a few yourself.

Every one of these hands you verifiable documents and leaves the trust
decision where it belongs: with you.

## 13. The protocol stops at interoperability

The protocol specifies only what two independent implementations need to
work together: bank-to-bank settlement, discovery, voucher feeds, and
sharing signed documents through a QR code or URL. Everything else is
deliberately unspecified.

Users may use the web app their bank serves, or any app of their own. An
app may aggregate vouchers from many banks into one UI — the app author's
call. Keypair management is implementation-specific too: browser keystore,
hardware wallet, a file on disk — the protocol only ever sees the pubkey
and the signatures. If a rule isn't needed for interoperability, it doesn't
belong in `protocol/`.

## 14. The wire is the protocol's truest surface

Every claim in barter.game reduces to signed documents and their hashes —
readable, re-hashable, verifiable by anyone. The reference web client keeps
that spirit: it verifies every signature in the browser and shows you
hashes, states, and signatures rather than asking you to trust a server's
rendering. Any client that hides the wire behind vibes is a worse client.
Anyone trying to understand barter.game can read what a client sends, what
the bank returns, and reconstruct the math.

## 15. Open source so anyone can be a bank

The code is public. The schema is public. The keys are yours. If we
disappear, you still have the protocol. If you don't like our bank, run
your own. If you don't trust any bank, your friends can run one. The
sovereignty in "be your own bank" includes the right to leave.

## 16. Open by default — moderation is key-blocking, not gatekeeping

A bank accepts anything tied to vouchers that reference it: any minting,
any docs, any signed call, from anyone. There is no registration step, no
allowlist, no approval queue. Every call is signed, so abuse has a name —
and the bank's recourse is to block the abuser's issuer key, not to put a
gate in front of everyone else. Gatekeeping is how alternative currencies
die before they start; key-blocking is how an open system stays usable.
The same posture powers post feeds: anyone can write, each bank decides
what it carries, and readers curate by their own trust graph.
