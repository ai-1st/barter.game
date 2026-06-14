# Scenario: Matchmaker Bilateral Arbitrage

Alice wants to sell Apromise for Bpromise. Bob wants to sell Bpromise for Apromise. A matchmaker discovers both Offers, matches them, and pockets a spread.

## Parties and terms

- Alice: user keypair `A.pub`. Offer at Abank: sell up to `100` Apromise, receive `90` Bpromise (`lead: true`).
- Bob: user keypair `B.pub`. Offer at Bbank: sell up to `100` Bpromise, receive `90` Apromise (`lead: true`).
- Matchmaker: user keypair `M.pub`. Has Accounts at both Abank and Bbank for both promises.
- Abank issues Apromise; Bbank issues Bpromise.

The matchmaker will arrange:

- Alice gives `100` Apromise and receives `90` Bpromise.
- Bob gives `100` Bpromise and receives `90` Apromise.
- Matchmaker receives `10` Apromise and `10` Bpromise as spread.

## Phase 0 — Matchmaker discovers Offers

The matchmaker subscribes to Offer streams from Abank and Bbank:

```json
{ "method": "subscribe_offers",
  "params": { "promise_hash": <apromise-hash>, "intention": "buy", "url": <matchmaker-url> },
  "pubkey": M.pub, "to": Abank.pub }

{ "method": "subscribe_offers",
  "params": { "promise_hash": <bpromise-hash>, "intention": "buy", "url": <matchmaker-url> },
  "pubkey": M.pub, "to": Bbank.pub }
```

Banks push Alice's and Bob's Offers to the matchmaker's URL.

## Phase 1 — Matchmaker creates records at each bank

The matchmaker cannot see Alice's or Bob's account hashes, but they know the Offer hashes and their own accounts. They call `create_records` with `offer_match` requests.

### At Abank (Apromise)

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <alice-apromise-offer-hash>,
        "amount": 90,
        "account_hash": <bob-apromise-account> },
      { "type": "offer_match",
        "offer_hash": <alice-apromise-offer-hash>,
        "amount": 10,
        "account_hash": <matchmaker-apromise-account> }
    ]
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank resolves Alice's Offer, validates the amounts and accounts, and mints:

- Record pair 1: debit Alice `90` Apromise, credit Bob `90` Apromise.
- Record pair 2: debit Alice `10` Apromise, credit Matchmaker `10` Apromise.

Abank returns all four record bodies.

### At Bbank (Bpromise)

```json
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "offer_match",
        "offer_hash": <bob-bpromise-offer-hash>,
        "amount": 90,
        "account_hash": <alice-bpromise-account> },
      { "type": "offer_match",
        "offer_hash": <bob-bpromise-offer-hash>,
        "amount": 10,
        "account_hash": <matchmaker-bpromise-account> }
    ]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank mints:

- Record pair 1: debit Bob `90` Bpromise, credit Alice `90` Bpromise.
- Record pair 2: debit Bob `10` Bpromise, credit Matchmaker `10` Bpromise.

## Phase 2 — Matchmaker builds Txs

All three parties share the same `deal` ULID. Each party builds a Tx containing only the records that touch their accounts.

**Alice's Tx:**
```ts
{
  type: "tx",
  pubkey: A.pub,
  ulid: <new>,
  deal: <deal-ulid>,
  records: [<alice-apromise-debit-90>, <alice-bpromise-credit-90>],
  offer: <alice-apromise-offer-hash>
}
```

**Bob's Tx:**
```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  deal: <deal-ulid>,
  records: [<bob-bpromise-debit-90>, <bob-apromise-credit-90>],
  offer: <bob-bpromise-offer-hash>
}
```

**Matchmaker's Tx:**
```ts
{
  type: "tx",
  pubkey: M.pub,
  ulid: <new>,
  deal: <deal-ulid>,
  records: [<matchmaker-apromise-credit-10>, <matchmaker-bpromise-credit-10>],
  offer: <alice-apromise-offer-hash>   // or any offer authorizing the matchmaker's credit
}
```

Because Alice's and Bob's Offers are `lead=true`, their holder signatures are **not required**. The matchmaker signs only their own Tx.

## Phase 3 — Matchmaker submits Txs

The matchmaker submits all three Txs to both banks. Each bank only processes the records it owns.

```json
// Alice's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <alice-tx>,
    "predecessors": []
  },
  "pubkey": M.pub, "to": Abank.pub }

// Bob's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <bob-tx>,
    "predecessors": []
  },
  "pubkey": M.pub, "to": Abank.pub }

// Matchmaker's Tx to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <matchmaker-tx>,
    "holder_signature": <matchmaker-lead-sig>,
    "predecessors": []
  },
  "pubkey": M.pub, "to": Abank.pub }
```

Abank now has authorization for every Apromise record:

- Alice's records are authorized by Alice's `lead` Offer.
- Bob's records are authorized by Bob's `lead` Offer (which is on Bbank, but Abank sees the Offer referenced in Bob's Tx and trusts the bank signature on it).
- Matchmaker's records are authorized by the matchmaker's own signature.

Abank issues `ready` on all records.

The matchmaker repeats the same three `submit_tx` calls at Bbank.

## Phase 4 — Hold

Abank sees that all its records are `ready` and at least one touching Tx is `lead` (Alice's Offer is `lead`, and the matchmaker signed as `lead`). Abank acquires holds on Alice's debit account and issues `hold` signatures.

Bbank is follower (none of the touching Txs are `lead` from Bbank's perspective; Bob's Offer is `lead` for Bpromise but it's an Offer, and the matchmaker's Tx might be follow). Bbank waits until it sees Abank's `hold` signatures, then acquires holds on Bob's debit account and issues `hold`.

The matchmaker relays Abank's `hold` to Bbank via subscription or by re-calling `submit_tx`.

## Phase 5 — Settle

Abank is lead. The matchmaker re-submits any Abank Tx. Abank applies balances:

- Alice: `-100` Apromise.
- Bob: `+90` Apromise.
- Matchmaker: `+10` Apromise.

Abank issues `settle` signatures.

The matchmaker relays Abank's `settle` to Bbank and calls `submit_tx` with `upstream_settles`:

```json
{ "method": "submit_tx",
  "params": {
    "tx": <alice-tx>,
    "predecessors": [Abank.pub],
    "upstream_settles": [<abank-settle-sig>]
  },
  "pubkey": M.pub, "to": Bbank.pub }
```

Bbank verifies Abank's settle, applies balances:

- Bob: `-100` Bpromise.
- Alice: `+90` Bpromise.
- Matchmaker: `+10` Bpromise.

Bbank issues `settle` signatures citing Abank's settle in `Signature.seen`.

## Result

- Alice gave `100` Apromise, got `90` Bpromise.
- Bob gave `100` Bpromise, got `90` Apromise.
- Matchmaker pocketed `10` Apromise and `10` Bpromise.
- Neither Alice nor Bob signed anything; their `lead` Offers authorized execution.
- Abank settled first; Bbank settled after verifying Abank's settle signature.
- Every bank's Apromise and Bpromise balances still sum to zero (or the agreed limit).
