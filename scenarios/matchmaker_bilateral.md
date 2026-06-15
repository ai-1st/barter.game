# Scenario: Matchmaker Bilateral Arbitrage

Alice wants to sell Avoucher for Bvoucher. Bob wants to sell Bvoucher for Avoucher. A matchmaker discovers both Offers, matches them, and pockets a spread.

## Parties and terms

- Alice: user keypair `A.pub`. Offer at Abank: sell up to `100` Avoucher, receive `90` Bvoucher (`lead: true`).
- Bob: user keypair `B.pub`. Offer at Bbank: sell up to `100` Bvoucher, receive `90` Avoucher (`lead: true`).
- Matchmaker: user keypair `M.pub`. Has Accounts at both Abank and Bbank for both vouchers.
- Abank issues Avoucher; Bbank issues Bvoucher.

The matchmaker will arrange:

- Alice gives `100` Avoucher and receives `90` Bvoucher.
- Bob gives `100` Bvoucher and receives `90` Avoucher.
- Matchmaker receives `10` Avoucher and `10` Bvoucher as spread.

## Phase 0 — Matchmaker discovers Offers

The matchmaker subscribes to Offer streams from Abank and Bbank by sending a `Subscription` doc whose `hashes` include the relevant watch keys (e.g., the voucher hashes):

```json
{ "method": "subscribe",
  "params": {
    "subscription": {
      type: "subscription",
      pubkey: M.pub,
      ulid: <new>,
      hashes: [<avoucher-hash>],
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
      hashes: [<bvoucher-hash>],
      url: <matchmaker-url>
    }
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Banks push Alice's and Bob's Offer signatures (and any later Offer-derived signatures matching the watch keys) to the matchmaker's URL.

## Phase 1 — Matchmaker creates records at each bank

The matchmaker cannot see Alice's or Bob's account hashes, but they know the Offer hashes and their own accounts. They call `create_records` with `offer_match` requests.

### At Abank (Avoucher)

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <alice-avoucher-offer-hash>,
        "amount": 90,
        "account_hash": <bob-avoucher-account> },
      { "type": "offer_match",
        "offer_hash": <alice-avoucher-offer-hash>,
        "amount": 10,
        "account_hash": <matchmaker-avoucher-account> }
    ],
    "record_subscriptions": [
      { "record": <alice-avoucher-debit-90-hash>, "url": <bbank-notify-url> },
      { "record": <bob-avoucher-credit-90-hash>, "url": <bbank-notify-url> },
      { "record": <matchmaker-avoucher-credit-10-hash>, "url": <bbank-notify-url> }
    ]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank resolves Alice's Offer, validates the amounts and accounts, and mints:

- Record pair 1: debit Alice `90` Avoucher, credit Bob `90` Avoucher.
- Record pair 2: debit Alice `10` Avoucher, credit Matchmaker `10` Avoucher.

Abank returns all four record bodies.

### At Bbank (Bvoucher)

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <bob-bvoucher-offer-hash>,
        "amount": 90,
        "account_hash": <alice-bvoucher-account> },
      { "type": "offer_match",
        "offer_hash": <bob-bvoucher-offer-hash>,
        "amount": 10,
        "account_hash": <matchmaker-bvoucher-account> }
    ],
    "record_subscriptions": [
      { "record": <bob-bvoucher-debit-90-hash>, "url": <abank-notify-url> },
      { "record": <alice-bvoucher-credit-90-hash>, "url": <abank-notify-url> },
      { "record": <matchmaker-bvoucher-credit-10-hash>, "url": <abank-notify-url> }
    ]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank mints:

- Record pair 1: debit Bob `90` Bvoucher, credit Alice `90` Bvoucher.
- Record pair 2: debit Bob `10` Bvoucher, credit Matchmaker `10` Bvoucher.

## Phase 2 — Matchmaker builds Txs

All three parties build their own Txs containing only the record hashes that touch their accounts.

**Alice's Tx:**
```ts
{
  type: "tx",
  pubkey: A.pub,
  ulid: <new>,
  records: [<alice-avoucher-debit-90-hash>, <alice-bvoucher-credit-90-hash>],
  offer: <alice-avoucher-offer-hash>
}
```

**Bob's Tx:**
```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  records: [<bob-bvoucher-debit-90-hash>, <bob-avoucher-credit-90-hash>],
  offer: <bob-bvoucher-offer-hash>
}
```

**Matchmaker's Tx:**
```ts
{
  type: "tx",
  pubkey: M.pub,
  ulid: <new>,
  records: [<matchmaker-avoucher-credit-10-hash>, <matchmaker-bvoucher-credit-10-hash>],
  offer: <alice-avoucher-offer-hash>   // or any offer authorizing the matchmaker's credit
}
```

Because Alice's and Bob's Offers are `lead=true`, their holder signatures are **not required**. The matchmaker signs only their own Tx.

## Phase 3 — Matchmaker submits Txs

The matchmaker submits all three Txs to both banks. Each bank only processes the records it owns.

```json
// Alice's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <alice-tx>
  },
  "pubkey": M.pub, "to": Abank.pub }

// Bob's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <bob-tx>
  },
  "pubkey": M.pub, "to": Abank.pub }

// Matchmaker's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <matchmaker-tx>,
    "holder_signature": <matchmaker-lead-sig>
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank now has authorization for every Avoucher record:

- Alice's records are authorized by Alice's `lead` Offer.
- Bob's records are authorized by Bob's `lead` Offer (which is on Bbank, but Abank sees the Offer referenced in Bob's Tx and trusts the bank signature on it).
- Matchmaker's records are authorized by the matchmaker's own signature.

Abank issues `ready` on all records.

The matchmaker repeats the same three `submit_tx` calls at Bbank.

## Phase 4 — Hold

Abank sees that all its records are `ready` and at least one touching Tx is `lead` (Alice's Offer is `lead`, and the matchmaker signed as `lead`). Abank's advance engine acquires holds on Alice's debit account and issues record-level `hold` Signatures.

Bbank is follower (none of the touching Txs are `lead` from Bbank's perspective; Bob's Offer is `lead` for Bvoucher but it's an Offer, and the matchmaker's Tx might be follow). Bbank waits until it sees Abank's `hold` Signatures via subscription fan-out (or client relay with `get_record_signatures` → `notify_signatures`), then acquires holds on Bob's debit account and issues its own record-level `hold` Signatures.

## Phase 5 — Settle

Abank is lead and has no predecessor dependency. Once Abank has observed record-level `hold` Signatures from Bbank on the corresponding records, its advance engine applies balances:

- Alice: `-100` Avoucher.
- Bob: `+90` Avoucher.
- Matchmaker: `+10` Avoucher.

Abank issues `settle` Signatures.

Bbank is follower. Once it has verified Abank's record-level `settle` Signatures via fan-out or client relay, its advance engine applies balances:

- Bob: `-100` Bvoucher.
- Alice: `+90` Bvoucher.
- Matchmaker: `+10` Bvoucher.

Bbank issues `settle` Signatures citing Abank's settle in `Signature.seen`.

## Result

- Alice gave `100` Avoucher, got `90` Bvoucher.
- Bob gave `100` Bvoucher, got `90` Avoucher.
- Matchmaker pocketed `10` Avoucher and `10` Bvoucher.
- Neither Alice nor Bob signed anything; their `lead` Offers authorized execution.
- Abank settled first; Bbank settled after verifying Abank's settle signature.
- Every bank's Avoucher and Bvoucher balances still sum to zero (or the agreed limit).
