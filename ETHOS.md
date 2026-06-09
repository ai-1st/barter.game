# Ethos

> **Why "game"?** barter.game is designed as a game first. We suggest treating it as a practice environment for trading skills — a safe space to experiment with personal currencies, negotiation, and settlement. Only use it for real economic transactions if your local laws and circumstances permit. The "game" framing keeps the stakes appropriate while the protocol itself is serious cryptography.

The beliefs driving barter.game. These are not requirements written into the
spec; they are the priors that shape every decision when the spec runs out.

## 1. Be your own bank

The fantasy is older than money: you, sovereign, issuing your own currency
backed by something you can deliver. Not a token wrapping a stablecoin. Not a
loyalty point. A signed promise — "1 logo, by Alice, due on demand." Yours.
You decide how many exist. You decide who gets them. You decide what they
cost.

The system exists to make this fantasy practical, not theoretical. Anyone
with a cloud account or own server can deploy a bank. Anyone with a
keyboard can mint a promise.

## 2. Trust is local; the protocol formalizes it

barter.game does NOT solve trust between strangers. It is a tool for people
who *already* trust each other and want to make their dealings precise. The
designer trading "1 logo" for "1 day of dev work" already has a relationship
with the developer. The friend group running an IOU system already knows
who's good for the round. The protocol records the deal; it does not
adjudicate it.

When we had to choose between "build a marketplace where strangers find
each other" and "build a settlement layer for people who already know each
other," we chose the latter without flinching. Discovery is out of band.
Reputation is out of band. The protocol's job is to give the existing trust
a verifiable surface — signed receipts, atomic ledger updates, no
ambiguity about who owes whom.

## 3. Mutual credit, not currency

When Alice mints "1 logo," she does not pre-fund anything. Her account at
her bank simply records `-1` — she owes the network one logo. When she
delivers, the holder's balance and her balance both move toward zero. The
sum across all accounts for any promise is always zero (or the agreed-on
limit). This is the LETS pattern, four decades old, with one cryptographic
upgrade: every step is signed.

We do not pretend personal currencies are money. They circulate among
people who hold the issuer accountable, and they die when the issuer
stops being accountable. That's the correct lifecycle.

## 4. Lead and follow — social risk over protocol risk

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
the lead party yells at the issuer of the promise not being delivered,
issuer yells at their bank operator, whom they presumably
know in person.

Distributed atomicity is the right answer for systems where the operators
are strangers. We are not that system.

## 5. No expirations — forever docs, no clock sync

The protocol deliberately avoids expirations, timeouts, and any mechanism that
requires synchronized clocks across participants.

- **All signatures and documents are irrevocable and eternal.** Once signed, a
doc lives forever in the content-addressed graph. There is no revocation
mechanism, no "cancel this signature" operation, and no TTL.
- **Standing orders are forever.** An `Order` (§5.7) remains valid for as long as
the holder maintains sufficient balance in the relevant account. The only limit
is the account itself.
- **Cancellation is mechanical, not administrative.** A holder who wants to stop
offering a promise empties the corresponding account. A bank that wishes to
release a hold without settling issues a `reject` signature on the Tx, which
becomes part of the public audit trail.
- **No clock synchronization.** Removing time-based expiry eliminates an entire
class of distributed-system bugs: clock skew, NTP failures, timezone confusion,
and race conditions around boundary timestamps. The only ordering guarantee is
the partial order established by `Signature.seen`.

This is a trade-off. It means abandoned holds must be cleaned up by operator
sweepers (a hygiene convenience, not a correctness mechanism) and that users
must manage their own exposure through account balance, not through time-boxed
authorizations.

## 6. Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks
talk to each other via signed HTTP. Anyone running the codebase can be
a peer. The v1 demo collapses four banks into one Supabase project for
operational simplicity; the *protocol* doesn't know or care. A fifth bank
can join tomorrow.

If barter.game ever centralized — even subtly, even for "the demo" — we
have built the wrong thing.

## 7. Content-addressed docs — almost all the way down

Promise, Pocket, Account, Order, and Signature docs are hashed by their
canonical JSON form. References between these docs use those hashes.
Nothing has an ID assigned by a server. Two banks that store the same
Promise doc store it under the same hash. Audit means walking the hash
graph; verification means re-hashing.

**Ledger records are the exception.** A `LedgerRecord` is minted by the
bank that issues it, assigned a ULID by that bank, and referenced by
ULID — not by content hash. The same logical transfer executed twice
will produce different record ULIDs, so the records are not content-
addressed. The `Tx` that groups those records also references them by
ULID, which means two independent builds of the same deal produce
different Tx hashes.

This trade-off makes the bank the sole authority for its ledger entries
and eliminates a class of client-side hash-mismatch bugs. The cross-
runtime canonical JSON parity test remains load-bearing for everything
that IS content-addressed (Promises, Accounts, Signatures, Orders).

## 8. The CLI is the protocol's truest surface

A clean command-line interface that drives the protocol end to end is
more honest than any web UI. The CLI shows you the hashes, the
signatures, the state transitions. Anyone trying to understand
barter.game can read what their CLI sends, what the bank returns, and
reconstruct the math.

The web UI is a polish layer that ships later. The protocol's truth
lives in the CLI.

## 9. Open source so anyone can be a bank

The code is public. The schema is public. The keys are yours. If we
disappear, you still have the protocol. If you don't like our bank, run
your own. If you don't trust any bank, your friends can run one. The
sovereignty in "be your own bank" includes the right to leave.
