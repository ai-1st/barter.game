# Scenario: Invoice

Alice runs a consulting business and publishes an invoice so anyone can pay her in Bvoucher. Bob decides to pay the invoice.

In the Order-only model, an invoice is a **credit-only Order**, surfaced for discovery as a credit-only Offer. To execute it, a Coordinator pairs it with a matching **debit-only Order** (a cheque) from the payer.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Coordinator: user keypair `M.pub`.
- Bbank: bank keypair `Bbank.pub`, issues Bvoucher.
- Alice has a Bvoucher Account at Bbank.
- Bob has a Bvoucher Account at Bbank.

## Step 1 — Alice publishes the invoice Order

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
    bank: Bbank.pub,
    min: 1,
    max: 1000
  },
  credit_account_limit: 10000,
  lead: false                    // payer's cheque Order will lead
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

Bbank stores the Order, derives and signs a discovery Offer hiding Alice's identity and account hash (the Offer's `order` field carries the invoice Order hash), and returns the Offer hash. The invoice Order itself stays bound at Bbank, addressable by its canonical Order hash.

## Step 2 — Bob publishes a cheque Order

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
    bank: Bbank.pub,
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

Bbank stores the Order, derives and signs a cheque Offer hiding Bob's account hash (the Offer's `order` field carries the cheque Order hash), and returns the Offer hash.

## Step 3 — Coordinator pairs the invoice and cheque

The Coordinator discovers both Offers via `list_offers` (or an off-band offer stream) and reads each Offer's `order` field to obtain the two canonical holder **Order hashes** — Alice's invoice Order and Bob's cheque Order. It never passes an Offer hash to `create_records`.

This is a same-bank transfer: Bbank issues the only voucher (Bvoucher), and Bob is the giver while Alice is the receiver. The Coordinator calls `create_records` **once** — Bbank moves Bvoucher from Bob to Alice. Both Orders are one-sided (invoice/cheque), so the two-sided rate check is skipped; `counter_amount` is `0`:

```json
{ "method": "create_records",
  "params": {
    "giver": <bob-cheque-order-hash>,
    "receiver": <invoice-order-hash>,
    "amount": 10,
    "counter_amount": 0,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank resolves `giver` to Bob's cheque Order (its `debit` side is here) and `receiver` to Alice's invoice Order (its `credit` side is here), validates `amount` against Bob's `debit.min/max` and Alice's `credit.min/max` plus Alice's `credit_account_limit`, and mints the Bvoucher debit/credit pair:

- Debit record: Bob's account, amount `10`, `order = <bob-cheque-order-hash>`.
- Credit record: Alice's account, amount `10`, `order = <invoice-order-hash>`.

Both records are tagged with `deal_id`, paired by a fresh `pair` ULID, and sealed with `details.coordinator = M.pub`. Bbank returns the record bodies. Because `M.pub` is sealed into each `RecordDetails`, only a Mandate signed by `M.pub` can later advance these records — knowing the `deal_id` alone is not enough.

## Step 4 — Coordinator sends Mandates

A Mandate is scoped **per (Order, bank)**. Both Orders are satisfied at Bbank, so the Coordinator builds one Mandate per Order — two Mandates, both addressed to Bbank.

Mandate for Bob's cheque Order (lists the debit record):

```ts
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <bob-cheque-order-hash>,
  bank: Bbank.pub,
  records: [<bob-debit-hash>]
}
```

Mandate for Alice's invoice Order (lists the credit record):

```ts
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <invoice-order-hash>,
  bank: Bbank.pub,
  records: [<alice-credit-hash>]
}
```

The Coordinator signs each Mandate and submits it with the record bodies it lists:

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <bob-cheque-mandate>,
    "records": [<bob-debit-record>]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <invoice-mandate>,
    "records": [<alice-credit-record>]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

For each Mandate, Bbank verifies the Coordinator's signature, that `mandate.bank` is its own pubkey, that each listed record was created for this `deal_id` with `details.coordinator == M.pub` and `Record.order == mandate.order`, and that no prior Mandate for the same `(deal_id, order)` was accepted.

## Step 5 — Bbank advances

Bbank now has, for each Order:

- A `Mandate` signed by the bound coordinator `M.pub` that lists the record.
- The authorizing Order (Bob's cheque Order, Alice's invoice Order).
- The record matching that Order.

Each record advances once its `(deal, order)` has a Mandate listing it and its Order is bound. Because Bob's cheque Order is `lead=true`, Bbank issues `ready`, holds Bob's debit account, and issues `hold` Signatures. Since Bbank is the only bank in the deal, it then applies `settle` immediately:

- Bob: `-10` Bvoucher.
- Alice: `+10` Bvoucher.

## Result

- Bob's Bvoucher balance decreases by `10`.
- Alice's Bvoucher balance increases by `10`.
- Alice never had to sign a payment-specific doc; her invoice Order authorized the credit.
- Bob authorized the debit via his cheque Order.
- The Coordinator never saw Alice's or Bob's account hashes.
- Bbank has issued verifiable `settle` Signatures on both records.
