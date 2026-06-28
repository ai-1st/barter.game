# Scenario: Bilateral Swap via Coordinator

Alice and Bob swap vouchers. Alice gives 1 Avoucher (issued by Abank) and receives 1 Bvoucher (issued by Bbank). Bob gives 1 Bvoucher and receives 1 Avoucher. A Coordinator discovers their public Offers, reads the underlying Orders, and asks each bank to create the connecting records.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Coordinator: user keypair `M.pub`.
- Abank: bank keypair `Abank.pub`, issues Avoucher.
- Bbank: bank keypair `Bbank.pub`, issues Bvoucher.
- Alice and Bob already have Accounts at both banks for the vouchers they will receive.

## Phase 0 — Holders publish intent

### Alice's Order

Alice wants to give 1 Avoucher and get 1 Bvoucher.

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 1,                       // 1 Avoucher / 1 Bvoucher
  debit: {
    account: <alice-avoucher-account>,
    voucher: <avoucher-hash>,
    bank: Abank.pub,
    min: 1,
    max: 1
  },
  credit: {
    account: <alice-bvoucher-account>,
    voucher: <bvoucher-hash>,
    bank: Bbank.pub,
    min: 1,
    max: 1
  },
  lead: true                     // Alice is willing to move first
}
```

Alice signs the Order and submits it to **both** Abank and Bbank via `submit_docs`, including the referenced Account docs and requesting Offer publication:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<alice-order>, <alice-avoucher-account>, <alice-bvoucher-account>],
    "publish_offers": [<alice-order-hash>]
  },
  "pubkey": A.pub, "to": Abank.pub }
```

Abank derives and publishes a discovery Offer for the Avoucher (debit) side of Alice's Order; Bbank derives one for the Bvoucher (credit) side. Each Offer's `order` field carries Alice's single canonical Order hash. The Order itself stays bound at both banks, addressable by that hash.

### Bob's Order

Bob wants to give 1 Bvoucher and get 1 Avoucher.

```ts
{
  type: "order",
  pubkey: B.pub,
  ulid: <new>,
  rate: 1,
  debit: {
    account: <bob-bvoucher-account>,
    voucher: <bvoucher-hash>,
    bank: Bbank.pub,
    min: 1,
    max: 1
  },
  credit: {
    account: <bob-avoucher-account>,
    voucher: <avoucher-hash>,
    bank: Abank.pub,
    min: 1,
    max: 1
  },
  lead: false                    // Bob waits for Abank to hold before moving
}
```

Bob signs and submits the Order to both banks via `submit_docs`, with Offer publication:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<bob-order>, <bob-avoucher-account>, <bob-bvoucher-account>],
    "publish_offers": [<bob-order-hash>]
  },
  "pubkey": B.pub, "to": Abank.pub }
```

Abank derives a buy-Avoucher Offer (Bob's credit side); Bbank derives a sell-Bvoucher Offer (Bob's debit side). Both point back to Bob's canonical Order hash.

## Phase 1 — Coordinator discovers Offers and resolves Orders

The Coordinator polls `list_offers` (or uses an off-band offer stream) at both banks. **Offers are a discovery surface only** — for each one the Coordinator reads the `order` field to obtain the canonical holder **Order hash**. It never passes an Offer hash to `create_records`; it passes Order hashes.

- At Abank: Alice's sell-Avoucher Offer → **Alice's Order hash**; Bob's buy-Avoucher Offer → **Bob's Order hash**.
- At Bbank: Bob's sell-Bvoucher Offer → **Bob's Order hash**; Alice's buy-Bvoucher Offer → **Alice's Order hash**.

Each Order has one canonical hash that resolves identically at every bank its sides touch.

## Phase 2 — Coordinator shares Address docs

Before Abank and Bbank can call each other directly, each must have the other's signed `Address` doc. The Coordinator fetches each bank's Address and submits it to the other bank via `submit_docs`:

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

The Coordinator picks a `deal_id` ULID shared across both banks. It makes one `create_records` call per bank, naming the `giver` Order (whose `debit` side is this bank's voucher) and the `receiver` Order (whose `credit` side is this bank's voucher), the `amount` of this bank's voucher moved giver → receiver, and the `counter_amount` of the counterparty voucher used for the two-sided rate check. The bank seals `deal_id` and the Coordinator's pubkey into each `RecordDetails`.

### At Abank (Avoucher issuer)

Alice's Order debits Avoucher (`giver`); Bob's Order credits Avoucher (`receiver`):

```json
{ "method": "create_records",
  "params": {
    "giver": <alice-order-hash>,
    "receiver": <bob-order-hash>,
    "amount": 1,
    "counter_amount": 1,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

`amount = 1` Avoucher moves Alice → Bob; `counter_amount = 1` is the Bvoucher moving the other way (at Bbank). Abank checks `1 / 1 <= alice.rate` and `1 / 1 <= bob.rate`, plus each side's `min`/`max`, then mints the Avoucher pair:

- Debit record: Alice's Avoucher account, amount `1`, `order` = Alice's Order hash.
- Credit record: Bob's Avoucher account, amount `1`, `order` = Bob's Order hash.

Both records are paired by a fresh `pair` ULID, tagged with `deal_id`, and sealed with `details.coordinator = M.pub`. Abank returns the record bodies.

### At Bbank (Bvoucher issuer)

Bob's Order debits Bvoucher (`giver`); Alice's Order credits Bvoucher (`receiver`):

```json
{ "method": "create_records",
  "params": {
    "giver": <bob-order-hash>,
    "receiver": <alice-order-hash>,
    "amount": 1,
    "counter_amount": 1,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank mints the Bvoucher pair:

- Debit record: Bob's Bvoucher account, amount `1`, `order` = Bob's Order hash.
- Credit record: Alice's Bvoucher account, amount `1`, `order` = Alice's Order hash.

## Phase 4 — Coordinator sends per-(Order, bank) Mandates

A Mandate is scoped **per (Order, bank)**. Each Order is two-sided across the two banks, so each gets a Mandate at the bank holding its debit record and another at the bank holding its credit record — **four Mandates** total.

```ts
// Alice's Order @ Abank — her Avoucher debit
{ type: "mandate", pubkey: M.pub, ulid: <new>, deal_id: <deal-id>,
  order: <alice-order-hash>, bank: Abank.pub,
  records: [<alice-avoucher-debit-hash>] }

// Bob's Order @ Abank — his Avoucher credit
{ type: "mandate", pubkey: M.pub, ulid: <new>, deal_id: <deal-id>,
  order: <bob-order-hash>, bank: Abank.pub,
  records: [<bob-avoucher-credit-hash>] }

// Bob's Order @ Bbank — his Bvoucher debit
{ type: "mandate", pubkey: M.pub, ulid: <new>, deal_id: <deal-id>,
  order: <bob-order-hash>, bank: Bbank.pub,
  records: [<bob-bvoucher-debit-hash>] }

// Alice's Order @ Bbank — her Bvoucher credit
{ type: "mandate", pubkey: M.pub, ulid: <new>, deal_id: <deal-id>,
  order: <alice-order-hash>, bank: Bbank.pub,
  records: [<alice-bvoucher-credit-hash>] }
```

The Coordinator signs each Mandate and submits it with the record bodies it lists:

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <alice-order-abank-mandate>,
    "records": [<alice-avoucher-debit-record>]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

For each Mandate, the bank verifies the Coordinator's signature, that `mandate.bank` is its own pubkey, that every listed record was created for this `deal_id` with `details.coordinator == M.pub` and `Record.order == mandate.order`, resolves `mandate.order` to the stored Order, and rejects a duplicate Mandate for the same `(deal_id, order)`.

## Phase 5 — Banks advance

Each owned record advances once its `(deal, order)` has a Mandate listing it, signed by the bound coordinator, and the Order is bound.

Because Alice's Order is `lead=true`, Abank issues `ready` on both its records, acquires the hold on Alice's Avoucher debit account, and issues `hold` Signatures.

Bbank also has its two Mandates and both Orders. Bob's Order includes `credit.bank = Abank.pub`, so Bbank looks up Abank's `Address` doc and calls Abank's `notify_signatures` endpoint directly. Because Bob's Order is `lead=false`, Bbank waits until it has verified Abank's `hold` Signatures. Once seen, Bbank issues `ready`, holds Bob's Bvoucher debit account, and issues `hold` Signatures.

Abank learns Bbank's URL from `credit.bank = Bbank.pub` on Alice's Order and calls Bbank's `notify_signatures` directly. Abank observes Bbank's `hold` Signatures and settles first, applying the Avoucher deltas:

- Alice: `-1` Avoucher.
- Bob: `+1` Avoucher.

Abank issues `settle` Signatures.

Bbank observes Abank's `settle` Signatures, cites them in `Signature.seen`, and settles the Bvoucher deltas:

- Bob: `-1` Bvoucher.
- Alice: `+1` Bvoucher.

## Result

- Alice owns `+1` Bvoucher at Bbank and owes `-1` Avoucher at Abank.
- Bob owns `+1` Avoucher at Abank and owes `-1` Bvoucher at Bbank.
- Alice authorized via her signed Order; Bob authorized via his signed Order.
- The Coordinator never saw Alice's or Bob's account hashes — only the Order hashes read from the discovery Offers and each bank's own record bodies.
- Knowing the `deal_id` was not enough to act: each record seals `details.coordinator = M.pub`, so only Mandates signed by `M.pub` could advance them.
- Abank settled first; Bbank settled after verifying Abank's `settle` signature.
