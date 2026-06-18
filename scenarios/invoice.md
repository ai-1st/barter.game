# Scenario: Invoice

Alice runs a consulting business and publishes an invoice so anyone can pay her in Bvoucher. Bob decides to pay the invoice.

In the Order-only model, an invoice is a **credit-only Offer**. To execute it, a matchmaker pairs it with a matching **debit-only Offer** (a cheque) from the payer.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Matchmaker: user keypair `M.pub`.
- Bbank: bank keypair `Bbank.pub`, issues Bvoucher.
- Alice has a Bvoucher Account at Bbank.
- Bob has a Bvoucher Account at Bbank.

## Step 1 — Alice publishes the invoice Offer

Alice builds an Order with `debit` omitted:

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 1,
  credit: {
    account: <alice-bvoucher-account>,
    voucher: <bvoucher-hash>,
    min: 1,
    max: 1000
  },
  credit_account_limit: 10000,
  lead: false                    // payer's debit Offer will lead
}
```

Alice signs the Order and calls `submit_docs` on Bbank with the Order, Account doc, and `publish_offers`:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<invoice-order>, <alice-bvoucher-account>],
    "publish_offers": [<invoice-order-hash>]
  },
  "pubkey": A.pub, "to": Bbank.pub }
```

Bbank stores the Order, derives and signs an Offer hiding Alice's identity and account hash, and returns the Offer hash.

## Step 2 — Bob publishes a cheque Offer

Bob authorizes Bbank to debit his account to pay the invoice. He builds an Order with `credit` omitted:

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
    max: 1000
  },
  lead: true                     // payer authorizes debit unconditionally
}
```

Bob signs the Order and calls `submit_docs` on Bbank with the Order, Account doc, and `publish_offers`:

```json
{ "method": "submit_docs",
  "params": {
    "docs": [<bob-cheque-order>, <bob-bvoucher-account>],
    "publish_offers": [<bob-cheque-order-hash>]
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Bbank stores the Order, derives and signs a cheque Offer hiding Bob's account hash, and returns the Offer hash.

## Step 3 — Matchmaker pairs the invoice and cheque

The matchmaker discovers both Offers on Bbank's public offer stream.

The matchmaker calls `create_records`. The invoice Offer has no debit side, so `offer1.debit_amount` is `0`; Bob's cheque Offer has no credit side, so `offer2.credit_amount` is `0`:

```json
{ "method": "create_records",
  "params": {
    "offer1": {
      "hash": <invoice-offer-hash>,
      "debit_amount": 0,
      "credit_amount": 10
    },
    "offer2": {
      "hash": <bob-cheque-offer-hash>,
      "debit_amount": 10,
      "credit_amount": 0
    },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank resolves both Offers to Alice's and Bob's Orders, validates the non-zero amounts against both limits, and creates:

- Debit record: Bob's account, amount `10`.
- Credit record: Alice's account, amount `10`.

Both records are tagged with `deal_id` and `pair`. Bbank returns the record bodies.

## Step 4 — Matchmaker sends Confirm

The matchmaker builds a per-bank `Confirm`:

```ts
{
  type: "confirm",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  bank: Bbank.pub,
  records: [<bob-debit-hash>, <alice-credit-hash>]
}
```

The matchmaker signs it and submits:

```json
{ "method": "submit_confirm",
  "params": { "confirm": <confirm> },
  "pubkey": M.pub, "to": Bbank.pub }
```

## Step 5 — Bbank advances

Bbank now has:

- A `Confirm` for this deal.
- Alice's invoice Order and Bob's cheque Order.
- Records matching both Orders.

Because Bob's cheque Order is `lead=true`, Bbank issues `ready`, holds Bob's debit account, and issues `hold` Signatures. Since Bbank is the only bank in the deal, it then applies `settle` immediately:

- Bob: `-10` Bvoucher.
- Alice: `+10` Bvoucher.

## Result

- Bob's Bvoucher balance decreases by `10`.
- Alice's Bvoucher balance increases by `10`.
- Alice never had to sign a payment-specific doc; her invoice Offer authorized the credit.
- Bob authorized the debit via his cheque Offer.
- The matchmaker never saw Alice's or Bob's account hashes.
- Bbank has issued verifiable `settle` Signatures on both records.
