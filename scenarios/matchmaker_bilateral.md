# Scenario: Matchmaker Bilateral Arbitrage

Alice wants to sell Avoucher for Bvoucher. Bob wants to sell Bvoucher for
Avoucher. A matchmaker discovers both Offers, matches them, and takes a spread
in both vouchers.

This version makes **Alice the lead holder** and **Bob the follower**. Alice's
bank (Abank) settles first; Bob's bank (Bbank) waits for Abank's `hold` before
locking and for Abank's `settle` before applying its own deltas.

## Parties and terms

- **Alice**: user keypair `A.pub`. Order at Abank: sell `100` Avoucher, receive
  `90` Bvoucher. `lead: true`.
- **Bob**: user keypair `B.pub`. Order at Bbank: sell `100` Bvoucher, receive
  `90` Avoucher. `lead: false`.
- **Matchmaker**: user keypair `M.pub`. Publishes credit-only buy Offers at both
  banks for the spread (`lead: true`, since the matchmaker is willing to receive
  the spread without waiting).
- **Abank** issues Avoucher; **Bbank** issues Bvoucher.

The matchmaker arranges:

- Alice gives `100` Avoucher.
- Bob gives `100` Bvoucher.
- Alice receives `90` Bvoucher.
- Bob receives `90` Avoucher.
- Matchmaker receives `10` Avoucher and `10` Bvoucher as spread.

> **Rate semantics.** `Order.rate` is a **maximum acceptable debit/credit ratio** checked across **all records of the deal** matched to that Order, not per pair. Alice's rate of `100/90` means `total_Avoucher_given / total_Bvoucher_received <= 100/90`. Bob's rate of `100/90` means `total_Bvoucher_given / total_Avoucher_received <= 100/90`. The bank defers the rate check to the `ready` phase, when every record for the deal is known.

## Phase 0 — Holders and matchmaker publish Offers

Alice, Bob, and the matchmaker sign Orders and submit them to the relevant
banks via `submit_docs`, requesting Offer publication.

**Alice's Order** (submitted to Abank and Bbank):

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 100 / 90,                 // 100 Avoucher = 90 Bvoucher
  debit:  { account: <alice-avoucher-account>, voucher: <avoucher-hash>, min: 1, max: 100 },
  credit: { account: <alice-bvoucher-account>, voucher: <bvoucher-hash>, min: 90, max: 90 },
  lead: true
}
```

**Bob's Order** (submitted to Abank and Bbank):

```ts
{
  type: "order",
  pubkey: B.pub,
  ulid: <new>,
  rate: 100 / 90,                 // 100 Bvoucher = 90 Avoucher
  debit:  { account: <bob-bvoucher-account>, voucher: <bvoucher-hash>, min: 1, max: 100 },
  credit: { account: <bob-avoucher-account>, voucher: <avoucher-hash>, min: 90, max: 90 },
  lead: false
}
```

**Matchmaker's Orders** (one per bank, credit-only):

```ts
// At Abank
{
  type: "order",
  pubkey: M.pub,
  ulid: <new>,
  rate: 1,                        // informational for a one-sided order
  credit: { account: <matchmaker-avoucher-account>, voucher: <avoucher-hash>, min: 1, max: 10 },
  credit_order_limit: 10,
  lead: true
}

// At Bbank
{
  type: "order",
  pubkey: M.pub,
  ulid: <new>,
  rate: 1,
  credit: { account: <matchmaker-bvoucher-account>, voucher: <bvoucher-hash>, min: 1, max: 10 },
  credit_order_limit: 10,
  lead: true
}
```

Each submission includes the referenced Account docs:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<order>, <account1>, <account2>],
    "publish_offers": [<order-hash>]
  },
  "pubkey": <holder-pubkey>, "to": <bank-pubkey> }
```

## Phase 1 — Matchmaker discovers Offers

The matchmaker subscribes to Offer streams from both banks and sees:

- At Abank:
  - Alice's sell-Avoucher Offer (`lead: true`, debit `100`, credit `90` Bvoucher implied).
  - Matchmaker's buy-Avoucher Offer (`lead: true`, credit-only, max `10`).
  - Bob's buy-Avoucher Offer (`lead: false`, credit side of his Order).
- At Bbank:
  - Bob's sell-Bvoucher Offer (`lead: false`, debit `100`, credit `90` Avoucher implied).
  - Matchmaker's buy-Bvoucher Offer (`lead: true`, credit-only, max `10`).
  - Alice's buy-Bvoucher Offer (`lead: true`, credit side of her Order).

## Phase 2 — Matchmaker creates records

The matchmaker chooses a `deal_id` ULID shared across all calls. Each
`create_records` call creates one debit/credit record pair.

### At Abank

Alice's `100` Avoucher is split between Bob (`90`) and the matchmaker (`10`).
The matchmaker makes two calls:

**Call 1 — Alice → Bob (`90` Avoucher):**

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <alice-sell-avoucher-offer-hash>,
      "debit_amount": 90,
      "credit_amount": 90
    },
    "offer2": {
      "hash": <bob-buy-avoucher-offer-hash>,
      "debit_amount": 90,
      "credit_amount": 90
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

**Call 2 — Alice → Matchmaker (`10` Avoucher spread):**

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <alice-sell-avoucher-offer-hash>,
      "debit_amount": 10,
      "credit_amount": 0
    },
    "offer2": {
      "hash": <matchmaker-buy-avoucher-offer-hash>,
      "debit_amount": 0,
      "credit_amount": 10
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank creates:

- Pair 1: debit Alice `90` Avoucher, credit Bob `90` Avoucher.
- Pair 2: debit Alice `10` Avoucher, credit Matchmaker `10` Avoucher.

### At Bbank

Bob's `100` Bvoucher is split between Alice (`90`) and the matchmaker (`10`):

**Call 1 — Bob → Alice (`90` Bvoucher):**

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <bob-sell-bvoucher-offer-hash>,
      "debit_amount": 90,
      "credit_amount": 90
    },
    "offer2": {
      "hash": <alice-buy-bvoucher-offer-hash>,
      "debit_amount": 90,
      "credit_amount": 90
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

**Call 2 — Bob → Matchmaker (`10` Bvoucher spread):**

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <bob-sell-bvoucher-offer-hash>,
      "debit_amount": 10,
      "credit_amount": 0
    },
    "offer2": {
      "hash": <matchmaker-buy-bvoucher-offer-hash>,
      "debit_amount": 0,
      "credit_amount": 10
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank creates:

- Pair 1: debit Bob `90` Bvoucher, credit Alice `90` Bvoucher.
- Pair 2: debit Bob `10` Bvoucher, credit Matchmaker `10` Bvoucher.

> **No rate check at record creation.** The spread legs use one-sided
> (credit-only) Offers, so `credit_amount` or `debit_amount` is `0` on those
> sides. The banks check `min`/`max` and amount equality for their own Voucher
> only. The aggregate `total_debit / total_credit <= rate` check for Alice's
> and Bob's two-sided Orders happens later, during the `ready` phase.

## Phase 3 — Matchmaker sends per-bank Confirm

The matchmaker builds two `Confirm` docs, one for each bank, listing only the
records that bank created:

```ts
// Confirm to Abank
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Abank.pub,
  records: [<alice-debit-90-hash>, <bob-credit-90-hash>,
            <alice-debit-10-hash>, <matchmaker-credit-10-hash>]
}

// Confirm to Bbank
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Bbank.pub,
  records: [<bob-debit-90-hash>, <alice-credit-90-hash>,
            <bob-debit-10-hash>, <matchmaker-credit-10-hash>]
}
```

The matchmaker signs each Confirm and submits it to the corresponding bank via
`submit_confirm`.

## Phase 4 — Three-phase settlement

The matchmaker also sets up cross-bank subscriptions so each bank receives the
other bank's signatures:

- Abank pushes its `ready`, `hold`, and `settle` signatures to Bbank's
  `notify_signatures` endpoint.
- Bbank pushes its `ready` and `hold` signatures to Abank's `notify_signatures`
  endpoint. (Bbank's `settle` cites Abank's `settle` in `Signature.seen`.)

### 4.1 Ready phase

Each bank independently validates its own records. A record is `ready` when:

1. The per-bank `Confirm` covers it.
2. `Record.order` resolves to a valid, stored Order or Offer.
3. The Order/Offer signature is valid and its `pubkey` matches the record's
   holder.
4. The record amount satisfies the Order/Offer `min`/`max`. For two-sided Orders, the bank waits until every record of the deal matched to that Order is known, then checks that `total_debit / total_credit <= rate`.
5. For paired records, the debit and credit amounts are equal for this bank's
   Voucher.
6. `Voucher.limit` and the Order's `debit_order_limit` / `credit_order_limit`
   are not exceeded.
7. The debit account has sufficient free balance, **or** the holder is the
   issuer authorizing a negative balance.

**At Abank (lead):**

- Alice's Order is `lead: true`, so Abank knows it is the lead bank.
- All four records pass validation.
- Abank issues `ready` signatures on all four records.

**At Bbank (follow):**

- Bob's Order is `lead: false`, so Bbank knows it is the follow bank.
- All four records still pass local validation (ready does **not** require
  upstream signatures).
- Bbank issues `ready` signatures on all four records.

### 4.2 Hold phase

A bank issues `hold` signatures only when all of its records are `ready` and
its lock preconditions are met.

**At Abank (lead):**

- Abank has all four `ready` signatures and no lock conflict.
- It aggregates the two debit records that touch Alice's Avoucher account
  (`90 + 10 = 100`) into a single hold of `100` Avoucher.
- It issues `hold` signatures on all four records and pushes them to Bbank.

**At Bbank (follow):**

- Bbank has all four `ready` signatures, but Bob's Order is `lead: false`.
- Bbank waits until it has verified Abank's `hold` signatures on the
  corresponding Avoucher records.
- Once Abank's `hold` signatures arrive and verify, Bbank aggregates Bob's two
  Bvoucher debit records (`90 + 10 = 100`) into a single hold of `100`
  Bvoucher.
- It issues `hold` signatures on all four Bbank records and pushes them to
  Abank.

### 4.3 Settle phase

**At Abank (lead):**

- Abank receives Bbank's `hold` signatures. The whole deal is now locked on
  both sides.
- Abank applies the deltas:
  - Alice: `-100` Avoucher.
  - Bob: `+90` Avoucher.
  - Matchmaker: `+10` Avoucher.
- It releases Alice's hold and issues `settle` signatures on all four records.
- It pushes the `settle` signatures to Bbank.

**At Bbank (follow):**

- Bbank receives Abank's `settle` signatures.
- It verifies them and applies its own deltas:
  - Bob: `-100` Bvoucher.
  - Alice: `+90` Bvoucher.
  - Matchmaker: `+10` Bvoucher.
- Bbank's `settle` signatures cite Abank's `settle` Signature hashes in
  `Signature.seen`, producing the verifiable cascade proof.
- It releases Bob's hold.

## Result

- Alice gave `100` Avoucher, got `90` Bvoucher.
- Bob gave `100` Bvoucher, got `90` Avoucher.
- Matchmaker accounted `10` Avoucher and `10` Bvoucher.
- The matchmaker never saw Alice's, Bob's, or its own account hashes at the
  other bank; it only handled Offer hashes and record bodies.
- Each bank received only its own slice: Avoucher records at Abank, Bvoucher
  records at Bbank.
- Abank settled first because Alice chose `lead: true`; Bbank followed because
  Bob chose `lead: false`.

## Attacks and ambiguities

### 1. Lead bank stalls after holding

Abank could issue `ready` and `hold` but never `settle`. Alice's Avoucher and
Bob's Bvoucher would both remain locked. There is **no protocol-level timeout**
in v1; the parties must resolve this socially or via an implementation-level
sweeper that releases stale holds.

### 2. Follow bank free-rides after lead settles

Abank settles first, moving Alice's Avoucher to Bob and the matchmaker. Bbank
could then refuse to settle Bob's Bvoucher. Alice would never receive her
Bvoucher credit, and Bob's Bvoucher would remain locked. This is the
**lead/follow risk**: Alice (as lead) chose to move before Bob's bank proved it
would reciprocate. The protocol records the choice; it does not enforce it.

### 3. Matchmaker withholds or forges signatures

If the matchmaker does not relay Abank's `hold`/`settle` signatures to Bbank,
Bbank cannot advance. Because signatures are self-verifying, anyone can relay
them, but in practice Bbank's notify URL may only be known to the matchmaker.
A malicious matchmaker can stall the deal indefinitely after record creation.

A matchmaker cannot forge Abank's signatures (it lacks Abank's private key),
but it can censor them.

### 4. Foreign Offer replay across multiple deals

Bob's buy-Avoucher Offer could be reused by multiple matchmakers in different
`deal_id`s. The bank prevents abuse through `credit_order_limit` and
`debit_order_limit`: once the cumulative matched amount reaches the limit, the
Offer is exhausted.

### 5. Amount/rate mismatch at record creation

The matchmaker might try to create records where the Avoucher and Bvoucher
amounts do not satisfy both Alice's and Bob's `rate`s. Abank and Bbank each
validate the local amount pair and the rates during `create_records`, so this
is caught before any hold is taken.

### 6. Premature follow hold

If Bbank incorrectly held Bob's Bvoucher before verifying Abank's `hold`, Bob
could be locked while Alice is not. The protocol requires follow banks to
verify the lead bank's `hold` signatures first.

### 7. Fake lead signatures

Bbank must verify that the `hold`/`settle` signatures it receives from Abank
are anchored to the actual record hashes from this deal, not arbitrary
signatures. It does this by checking the signature pubkey (`Abank.pub`) and
verifying the ed25519 signature over the canonical record hash.

### 8. Ambiguity: who decides which bank is lead?

In a two-bank deal, the bank whose holder's Order has `lead: true` is the lead.
If **both** holders set `lead: true`, both banks act as leads and settle
independently; there is no follower. If **both** set `lead: false`, neither
bank will hold or settle — the deal deadlocks. The matchmaker should detect
this during pairing and refuse to create records unless at least one side is
lead.

### 9. Account-name privacy vs. verification

Banks now store signed Account docs to verify `details.account` hashes. The
Account doc includes the `name` field, so the bank sees the holder's chosen
label. The protocol treats the name as private to the holder, but this is a
**trust assumption** on the bank operator. If stronger privacy is needed, the
name must be omitted from the bank-visible Account doc or encrypted.
