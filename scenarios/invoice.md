# Scenario: Invoice

Alice runs a consulting business and publishes an invoice so anyone can pay her in Bvoucher. Bob decides to pay the invoice.

An invoice is an **Order with `debit` omitted** — it authorizes an unconditional credit to the holder.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Bbank: bank keypair `Bbank.pub`, issues Bvoucher.
- Alice has a Bvoucher Account at Bbank.
- Bob has a Bvoucher Account at Bbank.

## Step 1 — Alice creates and publishes the invoice

Alice builds an Order with `debit` omitted:

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 1,                       // not strictly needed for a one-sided invoice, but present
  credit: {
    account: <alice-bvoucher-account>,
    voucher: <bvoucher-hash>,
    min: 1,
    max: 1000
  },
  credit_account_limit: 10000,
  lead: false                    // payer must sign follow; Alice does not lead
}
```

Alice signs the Order and calls `submit_order` on Bbank with `publish_offer: true`:

```json
{ "method": "submit_order",
  "params": {
    "order": <invoice-order>,
    "accounts": [<alice-bvoucher-account>],
    "publish_offer": true
  },
  "pubkey": A.pub, "to": Bbank.pub }
```

Bbank stores the Order, verifies Alice's account, derives an Offer hiding Alice's identity and account hash, signs the Offer with Bbank's key, and returns the Offer hash.

## Step 2 — Bob discovers the invoice and pays

Bob obtains the invoice Offer hash out-of-band (QR code, link, etc.). He wants to pay `10` Bvoucher.

Bob calls `create_records` on Bbank with an `offer_match` request:

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <invoice-offer-hash>,
        "amount": 10,
        "account_hash": <bob-bvoucher-account> }
    ]
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Bbank resolves the Offer to Alice's invoice Order, validates that Bob's account is a valid counterparty (payer) for `10` Bvoucher, and creates:

- Debit record: Bob's account, amount `10`.
- Credit record: Alice's account, amount `10`.

Bbank returns both record bodies.

## Step 3 — Bob authorizes the payment

Bob builds a Tx referencing the invoice Offer:

```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  records: [<bob-debit-hash>, <alice-credit-hash>],
  offer: <invoice-offer-hash>
}
```

Bob signs the Tx with `action="follow"` (paying an invoice is a follow action) and submits it to Bbank:

```json
{ "method": "submit_tx",
  "params": {
    "tx": <bob-tx>,
    "holder_signature": <bob-follow-sig>
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Bbank verifies:

- Bob's signature on the Tx.
- The Offer is valid, bank-signed, and matches the records.
- Bob has enough free balance.

Bbank issues per-record `ready` Signatures. Because Bbank is the only bank in the deal, its advance engine then acquires the hold and applies settle automatically.

## Result

- Bob's Bvoucher balance decreases by `10`.
- Alice's Bvoucher balance increases by `10`.
- Alice never had to sign; the invoice Offer authorized the credit.
- Bbank has issued verifiable `settle` Signatures on both records.
