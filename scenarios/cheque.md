# Scenario: Cheque

Alice writes a cheque authorizing anyone to debit her Avoucher account. Bob presents the cheque to Abank and receives `5` Avoucher.

In the Order-only model, a cheque is a **debit-only Offer**. To execute it, a matchmaker pairs it with a matching **credit-only Offer** (an invoice-style claim) from the recipient.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Matchmaker: user keypair `M.pub`.
- Abank: bank keypair `Abank.pub`, issues Avoucher.
- Alice has an Avoucher Account at Abank.
- Bob has an Avoucher Account at Abank.

## Step 1 — Alice publishes the cheque Offer

Alice builds an Order with `credit` omitted:

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 1,
  debit: {
    account: <alice-avoucher-account>,
    voucher: <avoucher-hash>,
    bank: Abank.pub,
    min: 1,
    max: 100
  },
  credit_order_limit: 1000,
  lead: true                     // cheque authorizes unconditional debit
}
```

Alice signs the Order and calls `submit_docs` on Abank with the Order, Account doc, and `publish_offers`:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<cheque-order>, <alice-avoucher-account>],
    "publish_offers": [<cheque-order-hash>]
  },
  "pubkey": A.pub, "to": Abank.pub }
```

Abank stores the Order, derives and signs a cheque Offer hiding Alice's account hash, and returns the Offer hash.

## Step 2 — Bob publishes a receiving Offer

Bob authorizes Abank to credit his account if someone matches his Offer. He builds an Order with `debit` omitted:

```ts
{
  type: "order",
  pubkey: B.pub,
  ulid: <new>,
  rate: 1,
  credit: {
    account: <bob-avoucher-account>,
    voucher: <avoucher-hash>,
    bank: Abank.pub,
    min: 1,
    max: 100
  },
  credit_account_limit: 10000,
  lead: false                    // Alice's cheque Offer leads
}
```

Bob signs the Order and calls `submit_docs` on Abank with the Order, Account doc, and `publish_offers`:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<bob-receiving-order>, <bob-avoucher-account>],
    "publish_offers": [<bob-receiving-order-hash>]
  },
  "pubkey": B.pub, "to": Abank.pub }
```

Abank stores the Order, derives and signs a credit-only Offer hiding Bob's account hash, and returns the Offer hash.

## Step 3 — Matchmaker pairs the cheque and receiving Offer

The matchmaker discovers both Offers via `list_offers` (or an off-band offer stream).

The matchmaker calls `create_records`. Alice's cheque Offer has no credit side, so `offer1.credit_amount` is `0`; Bob's receiving Offer has no debit side, so `offer2.debit_amount` is `0`:

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <alice-cheque-offer-hash>,
      "debit_amount": 5,
      "credit_amount": 0
    },
    "offer2": {
      "hash": <bob-receiving-offer-hash>,
      "debit_amount": 0,
      "credit_amount": 5
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank resolves both Offers to Alice's and Bob's Orders, validates the non-zero amounts against both limits, and creates:

- Debit record: Alice's account, amount `5`.
- Credit record: Bob's account, amount `5`.

Both records are tagged with `deal_id` and `pair`. Abank returns the record bodies.

## Step 4 — Matchmaker sends Confirm

The matchmaker builds a per-bank `Confirm`:

```ts
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Abank.pub,
  records: [<alice-debit-hash>, <bob-credit-hash>]
}
```

The matchmaker signs it and submits:

```json
{ "method": "submit_confirm",
  "params": { "confirm": <confirm> },
  "pubkey": M.pub, "to": Abank.pub }
```

## Step 5 — Abank advances

Abank now has:

- A `Confirm` for this deal.
- Alice's cheque Order and Bob's receiving Order.
- Records matching both Orders.

Because Alice's cheque Order is `lead=true`, Abank issues `ready`, holds Alice's debit account, and issues `hold` Signatures. Since Abank is the only bank in the deal, it then applies `settle` immediately:

- Alice: `-5` Avoucher.
- Bob: `+5` Avoucher.

## Result

- Alice's Avoucher balance decreases by `5`.
- Bob's Avoucher balance increases by `5`.
- Bob cashed the cheque without Alice's live involvement; her signed cheque Offer authorized the debit.
- The matchmaker never saw Alice's or Bob's account hashes.
- Abank has issued verifiable `settle` Signatures.
