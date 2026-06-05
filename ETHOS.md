# Ethos

The beliefs driving barter.game. These are not requirements written into the
spec; they are the priors that shape every decision when the spec runs out.

## 1. Be your own bank

The fantasy is older than money: you, sovereign, issuing your own currency
backed by something you can deliver. Not a token wrapping a stablecoin. Not a
loyalty point. A signed promise — "1 logo, by Alice, due on demand." Yours.
You decide how many exist. You decide who gets them. You decide what they
cost.

The system exists to make this fantasy practical, not theoretical. Anyone
with a credit card and ten minutes can deploy a bank. Anyone with a
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
level failure. Users already signed `confirm_receipt` saying they got the
goods. The remaining risk is one bank being uncooperative. In our trust
model (operators are known to their users), that risk is settled socially:
the lead party yells at the follow bank operator, whom they presumably
know in person.

Distributed atomicity is the right answer for systems where the operators
are strangers. We are not that system.

## 5. Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks
talk to each other via signed HTTP. Anyone running the codebase can be
a peer. The v1 demo collapses four banks into one Supabase project for
operational simplicity; the *protocol* doesn't know or care. A fifth bank
can join tomorrow.

If barter.game ever centralized — even subtly, even for "the demo" — we
have built the wrong thing.

## 6. Content-addressed docs, all the way down

Every doc — Promise, Pocket, Account, Record, Tx, Signature — is hashed
by its canonical JSON form. References between docs use those hashes.
Nothing has an ID assigned by a server. Two banks that store the same
doc store it under the same hash. Audit means walking the hash graph;
verification means re-hashing.

This is why the cross-runtime canonical JSON parity test is the
load-bearing test in the entire codebase. If Deno and Bun hash the same
doc to different bytes, every cryptographic claim collapses. We
hand-rolled the canonicalizer rather than depend on an npm shim that
might drift.

## 7. The CLI is the protocol's truest surface

A clean command-line interface that drives the protocol end to end is
more honest than any web UI. The CLI shows you the hashes, the
signatures, the state transitions. Anyone trying to understand
barter.game can read what their CLI sends, what the bank returns, and
reconstruct the math.

The web UI is a polish layer that ships later. The protocol's truth
lives in the CLI.

## 8. Open source so anyone can be a bank

The code is public. The schema is public. The keys are yours. If we
disappear, you still have the protocol. If you don't like our bank, run
your own. If you don't trust any bank, your friends can run one. The
sovereignty in "be your own bank" includes the right to leave.
