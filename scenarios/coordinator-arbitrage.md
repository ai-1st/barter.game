# Scenario: Coordinator Bilateral Arbitrage

Alice wants to sell Avoucher for Bvoucher. Bob wants to sell Bvoucher for
Avoucher. A Coordinator discovers both Offers, reads the underlying Orders,
matches them, and takes a spread in both vouchers.

This version makes **Alice the lead holder** and **Bob the follower**. Alice's
bank (Abank) settles first; Bob's bank (Bbank) waits for Abank's `hold` before
locking and for Abank's `settle` before applying its own deltas.

## Parties and terms

- **Alice**: user keypair `A.pub`. Order at Abank: sell `100` Avoucher, receive
  `90` Bvoucher. `lead: true`.
- **Bob**: user keypair `B.pub`. Order at Bbank: sell `100` Bvoucher, receive
  `90` Avoucher. `lead: false`.
- **Coordinator**: user keypair `M.pub`. Publishes credit-only buy Offers at
  both banks for the spread (`lead: true`, since the coordinator is willing to
  receive the spread without waiting). The Coordinator discovers Orders, calls
  `create_records`, and signs the Mandates.
- **Abank** issues Avoucher; **Bbank** issues Bvoucher.

The Coordinator arranges:

- Alice gives `100` Avoucher.
- Bob gives `100` Bvoucher.
- Alice receives `90` Bvoucher.
- Bob receives `90` Avoucher.
- Coordinator receives `10` Avoucher and `10` Bvoucher as spread.

> **Rate semantics.** `Order.rate` is a **maximum acceptable debit/credit ratio**
> checked across **all records of the deal** matched to that Order, not per pair.
> Alice's rate of `100/90` means `total_Avoucher_given / total_Bvoucher_received
> <= 100/90`. Bob's rate of `100/90` means `total_Bvoucher_given /
> total_Avoucher_received <= 100/90`. For these two-sided Orders the cross-bank
> ratio is the Coordinator-asserted `counter_amount` supplied at
> `create_records`; the holder's per-side `min`/`max`, enforced by whichever bank
> owns that side, is the cryptographically hard bound.

## Phase 0 — Holders and Coordinator publish Offers

Alice, Bob, and the Coordinator sign Orders and submit them to the relevant
banks via `submit_docs`, requesting Offer publication. **Offers are
discovery-only:** the Coordinator will read each Offer's `order` field to obtain
the underlying holder **Order hash** and reference *that Order hash* — never an
Offer hash — when it later calls `create_records`.

**Alice's Order** (submitted to Abank and Bbank):

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 100 / 90,                 // 100 Avoucher = 90 Bvoucher
  debit:  { account: <alice-avoucher-account>, voucher: <avoucher-hash>, bank: Abank.pub, min: 1, max: 100 },
  credit: { account: <alice-bvoucher-account>, voucher: <bvoucher-hash>, bank: Bbank.pub, min: 90, max: 90 },
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
  debit:  { account: <bob-bvoucher-account>, voucher: <bvoucher-hash>, bank: Bbank.pub, min: 1, max: 100 },
  credit: { account: <bob-avoucher-account>, voucher: <avoucher-hash>, bank: Abank.pub, min: 90, max: 90 },
  lead: false
}
```

**Coordinator's Orders** (one per bank, credit-only):

```ts
// At Abank
{
  type: "order",
  pubkey: M.pub,
  ulid: <new>,
  rate: 1,                        // informational for a one-sided order
  credit: { account: <coordinator-avoucher-account>, voucher: <avoucher-hash>, bank: Abank.pub, min: 1, max: 10 },
  credit_order_limit: 10,
  lead: true
}

// At Bbank
{
  type: "order",
  pubkey: M.pub,
  ulid: <new>,
  rate: 1,
  credit: { account: <coordinator-bvoucher-account>, voucher: <bvoucher-hash>, bank: Bbank.pub, min: 1, max: 10 },
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

## Phase 1 — Coordinator discovers Offers and resolves Orders

The Coordinator polls `list_offers` (or uses an off-band offer stream) at both
banks. Offers are a **discovery surface only** — for each Offer it cares about,
the Coordinator reads the `order` field to obtain the canonical holder **Order
hash**, which is what `create_records` will reference.

- At Abank:
  - Alice's sell-Avoucher Offer → resolves to **Alice's Order hash**
    (`lead: true`, debit `100`, credit `90` Bvoucher implied).
  - Coordinator's buy-Avoucher Offer → **Coordinator's Abank Order hash**
    (`lead: true`, credit-only, max `10`).
  - Bob's buy-Avoucher Offer → **Bob's Order hash** (`lead: false`, credit side
    of his Order).
- At Bbank:
  - Bob's sell-Bvoucher Offer → **Bob's Order hash** (`lead: false`, debit
    `100`, credit `90` Avoucher implied).
  - Coordinator's buy-Bvoucher Offer → **Coordinator's Bbank Order hash**
    (`lead: true`, credit-only, max `10`).
  - Alice's buy-Bvoucher Offer → **Alice's Order hash** (`lead: true`, credit
    side of her Order).

Each Offer references a single holder Order, and the same Order has one
canonical hash that resolves identically at every bank its sides touch. The
Coordinator never passes an Offer hash to `create_records`; it passes Order
hashes.

## Phase 2 — Coordinator shares Address docs

Before Abank and Bbank can exchange signatures directly, each must store the
other's signed `Address` doc. The Coordinator fetches each bank's Address with
`get_address` and submits it to the other bank via `submit_docs`:

```json
// Fetch Bbank's Address
{ "method": "get_address",
  "params": { "pubkey": Bbank.pub },
  "pubkey": M.pub, "to": Bbank.pub }

// Submit it to Abank
{ "method": "submit_docs",
  "params": { "docs": [<bbank-address-doc>] },
  "pubkey": M.pub, "to": Abank.pub }
```

Then symmetrically for Abank's Address to Bbank.

## Phase 3 — Coordinator creates records

The Coordinator chooses a `deal_id` ULID shared across all calls. Each
`create_records` call mints one debit/credit record pair of **that bank's
voucher**, referencing the two holder **Order hashes** (`giver`, `receiver`).
The `giver` is the Order whose `debit` side is this bank's voucher; the
`receiver` is the Order whose `credit` side is this bank's voucher. The bank
seals `deal_id` and the Coordinator's pubkey (`M.pub`) into each
`RecordDetails`.

### At Abank (Avoucher issuer)

Alice's `100` Avoucher is split between Bob (`90`) and the Coordinator (`10`).
The Coordinator makes two calls — each call's `giver.debit.voucher` is Avoucher:

**Call 1 — Alice → Bob (`90` Avoucher):**

```json
{ "method": "create_records",
  "params": {
    "giver": <alice-order-hash>,
    "receiver": <bob-order-hash>,
    "amount": 90,
    "counter_amount": 90,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

`amount = 90` Avoucher (Abank's voucher) moves Alice → Bob; `counter_amount =
90` is the Bvoucher Bob gives back (at Bbank), used for the two-sided rate check
against Alice's `100/90` and Bob's `90` credit min/max.

**Call 2 — Alice → Coordinator (`10` Avoucher spread):**

```json
{ "method": "create_records",
  "params": {
    "giver": <alice-order-hash>,
    "receiver": <coordinator-abank-order-hash>,
    "amount": 10,
    "counter_amount": 0,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

The Coordinator's Abank Order is credit-only (an invoice specialization), so its
side carries no rate; `counter_amount` is `0` and no cross-bank rate check
applies to this leg. Abank only checks `min`/`max` and the Order limits on its
own Avoucher.

Abank creates:

- Pair 1: debit Alice `90` Avoucher (on Alice's Order), credit Bob `90`
  Avoucher (on Bob's Order).
- Pair 2: debit Alice `10` Avoucher (on Alice's Order), credit Coordinator `10`
  Avoucher (on the Coordinator's Abank Order).

### At Bbank (Bvoucher issuer)

Bob's `100` Bvoucher is split between Alice (`90`) and the Coordinator (`10`).
Each call's `giver.debit.voucher` is Bvoucher:

**Call 1 — Bob → Alice (`90` Bvoucher):**

```json
{ "method": "create_records",
  "params": {
    "giver": <bob-order-hash>,
    "receiver": <alice-order-hash>,
    "amount": 90,
    "counter_amount": 90,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

`amount = 90` Bvoucher (Bbank's voucher) moves Bob → Alice; `counter_amount =
90` is the Avoucher Alice gives back (at Abank), used for the rate check against
Bob's `100/90` and Alice's `90` credit min/max.

**Call 2 — Bob → Coordinator (`10` Bvoucher spread):**

```json
{ "method": "create_records",
  "params": {
    "giver": <bob-order-hash>,
    "receiver": <coordinator-bbank-order-hash>,
    "amount": 10,
    "counter_amount": 0,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

The Coordinator's Bbank Order is credit-only, so `counter_amount` is `0` and no
cross-bank rate check applies to this leg.

Bbank creates:

- Pair 1: debit Bob `90` Bvoucher (on Bob's Order), credit Alice `90` Bvoucher
  (on Alice's Order).
- Pair 2: debit Bob `10` Bvoucher (on Bob's Order), credit Coordinator `10`
  Bvoucher (on the Coordinator's Bbank Order).

> **Rate at record creation.** For the two-sided legs (Alice ↔ Bob), each bank
> checks `amount / counter_amount <= giver.rate` and `counter_amount / amount <=
> receiver.rate` at `create_records` time. With `90 / 90 = 1 <= 100/90`, both
> sides pass. The spread legs use one-sided (credit-only) Orders, so they carry
> `counter_amount: 0` and skip the rate check; the bank verifies only `min`/`max`
> and the Order limits for its own Voucher. The aggregate per-Order rate check
> (`total_debit / total_credit <= rate`) is re-verified at the `ready` phase,
> when every record for the deal is known.

## Phase 4 — Coordinator sends per-(Order, bank) Mandates

A Mandate is scoped **per (Order, bank)**: each Order that has records at a bank
gets its own Mandate at that bank, listing exactly that bank's records for that
Order. Each Mandate seals `M.pub` as `pubkey` and is signed by the Coordinator.

At Abank, three Orders have Avoucher records (Alice's debit side, Bob's credit
side, and the Coordinator's credit side), so the Coordinator builds **three**
Mandates for Abank. Symmetrically, **three** for Bbank — six Mandates total.

```ts
// --- Mandates to Abank (Avoucher records) ---

// Alice's Order @ Abank — her two debit records
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <alice-order-hash>,
  bank: Abank.pub,
  records: [<alice-debit-90-hash>, <alice-debit-10-hash>]
}

// Bob's Order @ Abank — his credit record
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <bob-order-hash>,
  bank: Abank.pub,
  records: [<bob-credit-90-hash>]
}

// Coordinator's Abank Order @ Abank — the spread credit
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <coordinator-abank-order-hash>,
  bank: Abank.pub,
  records: [<coordinator-credit-10-avoucher-hash>]
}

// --- Mandates to Bbank (Bvoucher records) ---

// Bob's Order @ Bbank — his two debit records
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <bob-order-hash>,
  bank: Bbank.pub,
  records: [<bob-debit-90-hash>, <bob-debit-10-hash>]
}

// Alice's Order @ Bbank — her credit record
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <alice-order-hash>,
  bank: Bbank.pub,
  records: [<alice-credit-90-hash>]
}

// Coordinator's Bbank Order @ Bbank — the spread credit
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <coordinator-bbank-order-hash>,
  bank: Bbank.pub,
  records: [<coordinator-credit-10-bvoucher-hash>]
}
```

The Coordinator signs each Mandate and submits it via `submit_mandate`,
**together with the record bodies it lists**, so each request is self-contained:

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <alice-order-abank-mandate>,
    "records": [<alice-debit-90-body>, <alice-debit-10-body>]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

On each `submit_mandate`, the bank verifies the Coordinator's signature, that
`mandate.bank` is its own pubkey, that every listed record is one it created for
`deal_id` with `details.coordinator == M.pub` and `Record.order ==
mandate.order`, and resolves `mandate.order` to the stored Order. It rejects a
**duplicate** Mandate for the same `(deal_id, order)`. Knowing the `deal_id` is
not enough to act on the records — only the Coordinator that created them (whose
pubkey is sealed in `details.coordinator`) can sign a valid Mandate.

## Phase 5 — Three-phase settlement

Banks discover each other via the `bank` fields in the Orders. Alice's Order
tells Abank that the credit voucher is issued by Bbank; Bob's Order tells Bbank
that the credit voucher is issued by Abank. Each bank looks up the peer's
`Address` doc in the registry and calls the peer's `notify_signatures` endpoint
directly.

- Abank pushes its `ready`, `hold`, and `settle` signatures to Bbank's
  `notify_signatures` endpoint.
- Bbank pushes its `ready` and `hold` signatures to Abank's `notify_signatures`
  endpoint. (Bbank's `settle` cites Abank's `settle` in `Signature.seen`.)

### 5.1 Ready phase

Each bank independently validates its own records. A record is `ready` when:

1. A `Mandate` for the record's Order — signed by the bound Coordinator
   (`details.coordinator`) — lists it, and the Order is bound.
2. `Record.order` resolves to a valid, stored Order.
3. The Order signature is valid and its `pubkey` matches the record's holder.
4. The record amount satisfies the Order `min`/`max`. For two-sided Orders, the
   bank waits until every record of the deal matched to that Order is known,
   then checks that `total_debit / total_credit <= rate`.
5. For paired records, the debit and credit amounts are equal for this bank's
   Voucher.
6. `Voucher.limit` and the Order's `debit_order_limit` / `credit_order_limit`
   are not exceeded.
7. The debit account has sufficient free balance, **or** the holder is the
   issuer authorizing a negative balance.

**At Abank (lead):**

- Alice's Order is `lead: true`, so Abank knows it is the lead bank.
- All four records pass validation; their three Mandates (Alice's, Bob's,
  Coordinator's) are present.
- Abank issues `ready` signatures on all four records.

**At Bbank (follow):**

- Bob's Order is `lead: false`, so Bbank knows it is the follow bank.
- All four records still pass local validation (ready does **not** require
  upstream signatures), and their three Mandates are present.
- Bbank issues `ready` signatures on all four records.

### 5.2 Hold phase

A bank issues `hold` signatures only when all of its records are `ready` and its
lock preconditions are met.

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

### 5.3 Settle phase

**At Abank (lead):**

- Abank receives Bbank's `hold` signatures. The whole deal is now locked on both
  sides.
- Abank applies the deltas:
  - Alice: `-100` Avoucher.
  - Bob: `+90` Avoucher.
  - Coordinator: `+10` Avoucher.
- It releases Alice's hold and issues `settle` signatures on all four records.
- It pushes the `settle` signatures to Bbank.

**At Bbank (follow):**

- Bbank receives Abank's `settle` signatures.
- It verifies them and applies its own deltas:
  - Bob: `-100` Bvoucher.
  - Alice: `+90` Bvoucher.
  - Coordinator: `+10` Bvoucher.
- Bbank's `settle` signatures cite Abank's `settle` Signature hashes in
  `Signature.seen`, producing the verifiable cascade proof.
- It releases Bob's hold.

## Result

- Alice gave `100` Avoucher, got `90` Bvoucher.
- Bob gave `100` Bvoucher, got `90` Avoucher.
- Coordinator accounted `10` Avoucher and `10` Bvoucher.
- The Coordinator never saw Alice's, Bob's, or its own account hashes at the
  other bank; it only handled Order hashes and the record bodies of each bank's
  own slice.
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

Abank settles first, moving Alice's Avoucher to Bob and the Coordinator. Bbank
could then refuse to settle Bob's Bvoucher. Alice would never receive her
Bvoucher credit, and Bob's Bvoucher would remain locked. This is the
**lead/follow risk**: Alice (as lead) chose to move before Bob's bank proved it
would reciprocate. The protocol records the choice; it does not enforce it.

### 3. Coordinator withholds or forges signatures

Banks call each other directly using the Address registry, so the Coordinator is
not needed to relay signatures. If direct bank-to-bank delivery fails, any party
can still relay signatures by hand (`get_record_signatures` →
`notify_signatures`). A malicious Coordinator can no longer stall the deal by
withholding signatures, because Bbank can look up Abank's Address itself from
`credit.bank` on Bob's Order.

A Coordinator cannot forge Abank's signatures (it lacks Abank's private key).

### 4. Mandate hijack across coordinators

A second actor who learns the `deal_id` cannot drive these records: each record
seals `details.coordinator = M.pub` at creation, and every bank verifies that a
Mandate's `pubkey` matches the sealed coordinator and that the Mandate's
signature is valid. A Mandate signed by anyone other than the original
Coordinator is rejected, and a duplicate Mandate for the same `(deal_id, order)`
is rejected as well.

### 5. Foreign Order replay across multiple deals

Bob's Order could be referenced by multiple coordinators in different
`deal_id`s. The bank prevents abuse through `credit_order_limit` and
`debit_order_limit`: once the cumulative matched amount reaches the limit, the
Order is exhausted. The Coordinator's spread Orders cap at `10` via
`credit_order_limit`.

### 6. Amount/rate mismatch at record creation

The Coordinator might try to create records where the Avoucher and Bvoucher
amounts do not satisfy both Alice's and Bob's `rate`s. At `create_records` each
bank checks `amount / counter_amount <= giver.rate` and `counter_amount /
amount <= receiver.rate` for the two-sided legs, and the per-side `min`/`max`
(the hard bound) for every leg, so a bad ratio is caught before any hold is
taken.

### 7. Premature follow hold

If Bbank incorrectly held Bob's Bvoucher before verifying Abank's `hold`, Bob
could be locked while Alice is not. The protocol requires follow banks to verify
the lead bank's `hold` signatures first.

### 8. Fake lead signatures

Bbank must verify that the `hold`/`settle` signatures it receives from Abank are
anchored to the actual record hashes from this deal, not arbitrary signatures.
It does this by checking the signature pubkey (`Abank.pub`) and verifying the
ed25519 signature over the canonical record hash.

### 9. Ambiguity: who decides which bank is lead?

In a two-bank deal, the bank whose holder's Order has `lead: true` is the lead.
If **both** holders set `lead: true`, both banks act as leads and settle
independently; there is no follower. If **both** set `lead: false`, neither bank
will hold or settle — the deal deadlocks. The Coordinator should detect this
during pairing and refuse to create records unless at least one side is lead.

### 10. Account-name privacy vs. verification

Banks store signed Account docs to verify `details.account` hashes. The Account
doc includes the `name` field, so the bank sees the holder's chosen label. The
protocol treats the name as private to the holder, but this is a **trust
assumption** on the bank operator. If stronger privacy is needed, the name must
be omitted from the bank-visible Account doc or encrypted.
