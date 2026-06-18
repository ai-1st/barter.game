# Scenario: Matchmaker Bilateral Arbitrage

Alice wants to sell Avoucher for Bvoucher. Bob wants to sell Bvoucher for Avoucher. A matchmaker discovers both Offers, matches them, and takes a spread in both vouchers.

## Parties and terms

- Alice: user keypair `A.pub`. Offer at Abank: sell `100` Avoucher, receive `90` Bvoucher (`lead: true`).
- Bob: user keypair `B.pub`. Offer at Bbank: sell `100` Bvoucher, receive `90` Avoucher (`lead: true`).
- Matchmaker: user keypair `M.pub`. Publishes buy Offers at both banks for the spread.
- Abank issues Avoucher; Bbank issues Bvoucher.

The matchmaker will arrange:

- Alice gives `100` Avoucher.
- Bob gives `100` Bvoucher.
- Alice receives `90` Bvoucher.
- Bob receives `90` Avoucher.
- Matchmaker receives `10` Avoucher and `10` Bvoucher as spread.

## Phase 0 — Holders and matchmaker publish Offers

Alice and Bob each sign an Order and submit it to both banks, letting each bank derive and publish the relevant Offer. The matchmaker also signs two one-sided Orders:

- At Abank: a credit-only Order (invoice-style) authorizing a credit of up to `10` Avoucher to the matchmaker's account.
- At Bbank: a credit-only Order authorizing a credit of up to `10` Bvoucher to the matchmaker's account.

The matchmaker submits these Orders to Abank and Bbank with `publish_offer: true`.

## Phase 1 — Matchmaker discovers Offers

The matchmaker subscribes to Offer streams from both banks and sees:

- At Abank:
  - Alice's sell-Avoucher Offer (debit `100`, credit `90` Bvoucher implied).
  - Matchmaker's buy-Avoucher Offer (credit-only, max `10`).
- At Bbank:
  - Bob's sell-Bvoucher Offer (debit `100`, credit `90` Avoucher implied).
  - Matchmaker's buy-Bvoucher Offer (credit-only, max `10`).

## Phase 2 — Matchmaker creates records

The matchmaker chooses a `deal_id` ULID shared across all calls. Each `create_records` call creates one debit/credit record pair.

### At Abank

Alice's `100` Avoucher is split between Bob (`90`) and the matchmaker (`10`). The matchmaker makes two calls:

**Call 1 — Alice → Bob (`90` Avoucher):**

```json
{ "method": "create_records",
  "params": {
    "offer1": <alice-sell-avoucher-offer-hash>,
    "debit_amount1": 90,
    "credit_amount1": 81,
    "offer2": <bob-buy-avoucher-offer-hash>,
    "credit_amount2": 90,
    "debit_amount2": 81,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

**Call 2 — Alice → Matchmaker (`10` Avoucher):**

```json
{ "method": "create_records",
  "params": {
    "offer1": <alice-sell-avoucher-offer-hash>,
    "debit_amount1": 10,
    "credit_amount1": 9,
    "offer2": <matchmaker-buy-avoucher-offer-hash>,
    "credit_amount2": 10,
    "debit_amount2": 9,
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
    "offer1": <bob-sell-bvoucher-offer-hash>,
    "debit_amount1": 90,
    "credit_amount1": 81,
    "offer2": <alice-buy-bvoucher-offer-hash>,
    "credit_amount2": 90,
    "debit_amount2": 81,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

**Call 2 — Bob → Matchmaker (`10` Bvoucher):**

```json
{ "method": "create_records",
  "params": {
    "offer1": <bob-sell-bvoucher-offer-hash>,
    "debit_amount1": 10,
    "credit_amount1": 9,
    "offer2": <matchmaker-buy-bvoucher-offer-hash>,
    "credit_amount2": 10,
    "debit_amount2": 9,
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank creates:

- Pair 1: debit Bob `90` Bvoucher, credit Alice `90` Bvoucher.
- Pair 2: debit Bob `10` Bvoucher, credit Matchmaker `10` Bvoucher.

## Phase 3 — Matchmaker sends per-bank Confirm

The matchmaker builds two `Confirm` docs, one for each bank, listing only the records that bank created:

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

The matchmaker signs each Confirm and submits it to the corresponding bank via `submit_confirm`.

## Phase 4 — Hold and settle

Alice's and Bob's Offers are `lead=true`. Once each bank has its `Confirm` and the matching Orders, it issues `ready`, holds the debit accounts, and issues `hold` Signatures.

Because both sides lead, either bank may settle first. Suppose Abank settles first:

- Alice: `-100` Avoucher.
- Bob: `+90` Avoucher.
- Matchmaker: `+10` Avoucher.

Bbank verifies Abank's `settle` Signatures, cites them in `Signature.seen`, and settles:

- Bob: `-100` Bvoucher.
- Alice: `+90` Bvoucher.
- Matchmaker: `+10` Bvoucher.

## Result

- Alice gave `100` Avoucher, got `90` Bvoucher.
- Bob gave `100` Bvoucher, got `90` Avoucher.
- Matchmaker accounted `10` Avoucher and `10` Bvoucher.
- The matchmaker never saw Alice's, Bob's, or its own account hashes at the other bank; it only handled Offer hashes and record bodies.
- Each bank received only its own slice: Avoucher records at Abank, Bvoucher records at Bbank.
