# Scenario: Cheque

Alice writes a cheque authorizing anyone to debit her Avoucher account. Bob presents the cheque to Abank and receives `5` Avoucher.

In the Order-only model, a cheque is a **debit-only Order** (`credit` omitted). To execute it, a Coordinator pairs it with a matching **credit-only Order** (an invoice-style claim) from the recipient. Offers are discovery-only: the Coordinator scans them to learn each holder's canonical **Order hash**, then drives the deal off those Orders.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Coordinator: user keypair `M.pub`.
- Abank: bank keypair `Abank.pub`, issues Avoucher.
- Alice has an Avoucher Account at Abank.
- Bob has an Avoucher Account at Abank.

## Step 1 — Alice publishes the cheque Order

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
  debit_order_limit: 1000,
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

Abank stores the Order, derives and signs a cheque Offer (debit-only) hiding Alice's account hash. The Offer's `order` field carries the canonical cheque-Order hash, which is what a Coordinator will reference on the execute path.

## Step 2 — Bob publishes a receiving Order

Bob authorizes Abank to credit his account if someone matches his Order. He builds an Order with `debit` omitted:

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
  lead: false                    // Alice's cheque Order leads
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

Abank stores the Order, derives and signs a credit-only Offer hiding Bob's account hash. The Offer's `order` field carries the canonical receiving-Order hash.

## Step 3 — Coordinator pairs the cheque and receiving Orders

The Coordinator discovers both Offers via `list_offers` (or an off-band offer stream) and reads each Offer's `order` field to obtain the two canonical **Order hashes**: Alice's cheque Order (`giver`, its `debit` side is here) and Bob's receiving Order (`receiver`, its `credit` side is here).

Both vouchers in this swap are Avoucher — a single voucher issued by a single bank. There is only **one** transfer of Avoucher to mint (Alice → Bob), so the Coordinator calls `create_records` **once** on Abank. The cheque/invoice pair is one-sided on each Order, so there is no two-sided rate check; `counter_amount` is `0`:

```json
{ "method": "create_records",
  "params": {
    "giver": <alice-cheque-order-hash>,
    "receiver": <bob-receiving-order-hash>,
    "amount": 5,
    "counter_amount": 0,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank resolves both Order hashes to Alice's cheque Order and Bob's receiving Order, checks `amount` against `giver.debit.min/max` and `receiver.credit.min/max` (both one-sided, so the rate check is skipped), and mints the Avoucher transfer:

- Debit record: Alice's account, amount `5`, `order` = Alice's cheque-Order hash.
- Credit record: Bob's account, amount `5`, `order` = Bob's receiving-Order hash.

Both records are paired by a fresh `pair` ULID, tagged with `deal_id`, and sealed with `details.coordinator = M.pub`. Abank returns the record bodies. The records sit in `created` until a `Mandate` arrives.

## Step 4 — Coordinator sends Mandates

A Mandate is scoped **per (Order, bank)**. This deal has two Orders whose records all live at Abank, so the Coordinator builds **two** Mandates — one per Order — each listing the record(s) at Abank that satisfy that Order.

Mandate for Alice's cheque Order (its debit record):

```ts
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <alice-cheque-order-hash>,
  bank: Abank.pub,
  records: [<alice-debit-hash>]
}
```

Mandate for Bob's receiving Order (its credit record):

```ts
{
  type: "mandate",
  pubkey: M.pub,
  ulid: <new>,
  deal_id: <deal-id>,
  order: <bob-receiving-order-hash>,
  bank: Abank.pub,
  records: [<bob-credit-hash>]
}
```

The Coordinator signs each Mandate and submits it with the record bodies it lists:

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <alice-cheque-mandate>,
    "records": [<alice-debit-record>]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

```json
{ "method": "submit_mandate",
  "params": {
    "mandate": <bob-receiving-mandate>,
    "records": [<bob-credit-record>]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

For each Mandate, Abank verifies the Coordinator's signature, that `mandate.bank == Abank.pub`, that each listed record was created for this `deal_id` with `details.coordinator == M.pub` and `Record.order == mandate.order`, resolves `mandate.order` to the stored Order, and rejects any duplicate Mandate for the same `(deal_id, order)`.

## Step 5 — Abank advances

Abank now has, for each Order in the deal:

- A `Mandate` from the bound coordinator (`M.pub`) that lists that Order's record.
- The Order itself — Alice's cheque Order and Bob's receiving Order.
- The record matching that Order, sealed with `details.coordinator = M.pub`.

The advance gate is met for both records: each `(deal, order)` has a Mandate listing it, signed by the bound coordinator, and the Order is bound. Because Alice's cheque Order is `lead=true`, Abank issues `ready`, holds Alice's debit account, and issues `hold` Signatures. Since Abank is the only bank in the deal, it then applies `settle` immediately:

- Alice: `-5` Avoucher.
- Bob: `+5` Avoucher.

## Result

- Alice's Avoucher balance decreases by `5`.
- Bob's Avoucher balance increases by `5`.
- Bob cashed the cheque without Alice's live involvement; her signed cheque Order authorized the debit.
- The Coordinator never saw Alice's or Bob's account hashes — only the Order hashes read from the discovery Offers.
- Knowing the `deal_id` was not enough to act: each record is sealed with `details.coordinator = M.pub`, so only Mandates signed by `M.pub` could advance them.
- Abank has issued verifiable `settle` Signatures.
