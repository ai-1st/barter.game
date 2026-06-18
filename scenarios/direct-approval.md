# Scenario: Bilateral Swap via Matchmaker

Alice and Bob swap vouchers. Alice gives 1 Avoucher (issued by Abank) and receives 1 Bvoucher (issued by Bbank). Bob gives 1 Bvoucher and receives 1 Avoucher. A matchmaker discovers their public Offers and asks each bank to create the connecting records.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Matchmaker: user keypair `M.pub`.
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
    min: 1,
    max: 1
  },
  credit: {
    account: <alice-bvoucher-account>,
    voucher: <bvoucher-hash>,
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

Abank derives and publishes an Offer from Alice's Order for the Avoucher side. Bbank derives and publishes an Offer for the Bvoucher side.

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
    min: 1,
    max: 1
  },
  credit: {
    account: <bob-avoucher-account>,
    voucher: <avoucher-hash>,
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

Abank derives a buy-Avoucher Offer; Bbank derives a sell-Bvoucher Offer.

## Phase 1 — Matchmaker discovers Offers

The matchmaker subscribes to Offer streams from both banks:

```json
{ "method": "subscribe",
  "params": {
    "subscription": {
      type: "subscription",
      pubkey: M.pub,
      ulid: <new>,
      voucher: <avoucher-hash>,
      url: <matchmaker-url>
    }
  },
  "pubkey": M.pub, "to": Abank.pub }

{ "method": "subscribe",
  "params": {
    "subscription": {
      type: "subscription",
      pubkey: M.pub,
      ulid: <new>,
      voucher: <bvoucher-hash>,
      url: <matchmaker-url>
    }
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

The matchmaker sees:

- At Abank: Alice's sell-Avoucher Offer and Bob's buy-Avoucher Offer.
- At Bbank: Bob's sell-Bvoucher Offer and Alice's buy-Bvoucher Offer.

## Phase 2 — Matchmaker creates records

The matchmaker picks a `deal_id` ULID shared across all banks and calls `create_records` at **both** banks with the same nested Offer objects:

- `offer1` = Alice's Offer (debit Avoucher `1`, credit Bvoucher `1`).
- `offer2` = Bob's Offer (debit Bvoucher `1`, credit Avoucher `1`).

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <alice-cross-voucher-offer-hash>,
      "debit_amount": 1,
      "credit_amount": 1
    },
    "offer2": {
      "hash": <bob-cross-voucher-offer-hash>,
      "debit_amount": 1,
      "credit_amount": 1
    },
    "deal_id": <deal-id>,
    "record_subscriptions": [
      { "record": <alice-avoucher-debit-hash>, "url": <abank-notify-url> },
      { "record": <bob-avoucher-credit-hash>, "url": <abank-notify-url> }
    ]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank sees that Alice's Offer debits Avoucher and Bob's Offer credits Avoucher. It uses `offer1.debit_amount` and `offer2.credit_amount` to create the Avoucher record pair:

- Debit record: Alice's Avoucher account, amount `1`.
- Credit record: Bob's Avoucher account, amount `1`.

Both records are tagged with `deal_id` and `pair`. Abank returns the record bodies.

The matchmaker makes the same call at Bbank:

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <alice-cross-voucher-offer-hash>,
      "debit_amount": 1,
      "credit_amount": 1
    },
    "offer2": {
      "hash": <bob-cross-voucher-offer-hash>,
      "debit_amount": 1,
      "credit_amount": 1
    },
    "deal_id": <deal-id>,
    "record_subscriptions": [
      { "record": <bob-bvoucher-debit-hash>, "url": <bbank-notify-url> },
      { "record": <alice-bvoucher-credit-hash>, "url": <bbank-notify-url> }
    ]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank uses `offer1.credit_amount` and `offer2.debit_amount` to create the Bvoucher record pair:

- Debit record: Bob's Bvoucher account, amount `1`.
- Credit record: Alice's Bvoucher account, amount `1`.

## Phase 3 — Matchmaker sends Confirm

The matchmaker builds a per-bank `Confirm` listing the records that bank created:

```ts
// Confirm to Abank
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Abank.pub,
  records: [<alice-avoucher-debit-hash>, <bob-avoucher-credit-hash>]
}

// Confirm to Bbank
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Bbank.pub,
  records: [<bob-bvoucher-debit-hash>, <alice-bvoucher-credit-hash>]
}
```

The matchmaker signs each Confirm and sends it to the corresponding bank:

```json
{ "method": "submit_confirm",
  "params": { "confirm": <abank-confirm> },
  "pubkey": M.pub, "to": Abank.pub }

{ "method": "submit_confirm",
  "params": { "confirm": <bbank-confirm> },
  "pubkey": M.pub, "to": Bbank.pub }
```

## Phase 4 — Banks advance

Abank now has:

- A `Confirm` for this deal.
- Alice's and Bob's Orders (submitted earlier).
- Records matching both Orders.

Because Alice's Order is `lead=true`, Abank issues `ready` on both records, acquires the hold on Alice's debit account, and issues `hold` Signatures.

Bbank also has its `Confirm` and Orders. Because Bob's Order is `lead=false`, Bbank waits until it sees Abank's `hold` Signatures via subscription fan-out (or relay). Once seen, Bbank issues `ready`, holds Bob's debit account, and issues `hold` Signatures.

Abank observes Bbank's `hold` Signatures and settles first, applying the Avoucher deltas:

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
- The matchmaker never saw Alice's or Bob's account hashes; it only handled Offer hashes and record bodies.
- Abank settled first; Bbank settled after verifying Abank's settle signature.
