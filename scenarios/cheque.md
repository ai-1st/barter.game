# Scenario: Cheque

Alice writes a cheque authorizing anyone to debit her Apromise account. Bob presents the cheque to Abank and receives `5` Apromise.

A cheque is an **Order with `credit` omitted** — it authorizes an unconditional debit from the holder.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Abank: bank keypair `Abank.pub`, issues Apromise.
- Alice has an Apromise Account at Abank.
- Bob has an Apromise Account at Abank.

## Step 1 — Alice creates and publishes the cheque

Alice builds an Order with `credit` omitted:

```ts
{
  type: "order",
  pubkey: A.pub,
  ulid: <new>,
  rate: 1,
  debit: {
    account: <alice-apromise-account>,
    promise: <apromise-hash>,
    min: 1,
    max: 100
  },
  credit_order_limit: 1000,
  lead: true                     // cheque authorizes unconditional debit; holder leads
}
```

Alice signs the Order and calls `submit_order` on Abank with `publish_offer: true`:

```json
{ "method": "submit_order",
  "params": {
    "order": <cheque-order>,
    "accounts": [<alice-apromise-account>],
    "publish_offer": true
  },
  "pubkey": A.pub, "to": Abank.pub }
```

Abank stores the Order, derives and signs an Offer, and returns the Offer hash.

## Step 2 — Bob discovers and cashes the cheque

Bob obtains the cheque Offer hash. He wants to cash `5` Apromise into his account.

Bob calls `create_records` on Abank:

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <cheque-offer-hash>,
        "amount": 5,
        "account_hash": <bob-apromise-account> }
    ]
  },
  "pubkey": B.pub, "to": Abank.pub }
```

Abank resolves the Offer to Alice's cheque Order, validates Bob's account as the credit counterparty, and creates:

- Debit record: Alice's account, amount `5`.
- Credit record: Bob's account, amount `5`.

## Step 3 — Bob submits the cheque Tx

Bob builds a Tx referencing the cheque Offer:

```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  records: [<alice-debit-hash>, <bob-credit-hash>],
  offer: <cheque-offer-hash>
}
```

Because the cheque Offer is `lead=true`, Bob does **not** need to provide a holder signature for Alice. Bob signs the envelope as the caller and submits:

```json
{ "method": "submit_tx",
  "params": {
    "tx": <bob-tx>
  },
  "pubkey": B.pub, "to": Abank.pub }
```

Abank verifies:

- The Offer is valid, bank-signed, and `lead=true`.
- The records match the cheque terms.
- Alice has enough free balance.

Abank issues per-record `ready` Signatures. Because Abank is the only bank in the deal, its advance engine then acquires the hold and applies settle automatically.

## Result

- Alice's Apromise balance decreases by `5`.
- Bob's Apromise balance increases by `5`.
- Bob cashed the cheque without Alice's live involvement; the signed cheque Offer was the authorization.
- Abank has issued verifiable `settle` Signatures.
