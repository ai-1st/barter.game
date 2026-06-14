# Scenario: Direct Approval Bilateral Swap

Alice and Bob swap promises directly. Alice gives 1 Apromise (issued by Abank) and receives 1 Bpromise (issued by Bbank). Bob gives 1 Bpromise and receives 1 Apromise. Alice acts as lead; Bob follows.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Abank: bank keypair `Abank.pub`, issues Apromise.
- Bbank: bank keypair `Bbank.pub`, issues Bpromise.
- All parties already have Accounts for the promises they will receive, created via `submit_account`.

## Phase 0 — Create records

Alice (the coordinator) builds two explicit transfers:

1. At Abank: debit Alice's Apromise account, credit Bob's Apromise account, amount `1`.
2. At Bbank: debit Bob's Bpromise account, credit Alice's Bpromise account, amount `1`.

Alice calls `create_records` on each bank:

```json
// to Abank
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "transfer",
        "promise_hash": <apromise-hash>,
        "amount": 1,
        "debit_account_hash": <alice-apromise-account>,
        "credit_account_hash": <bob-apromise-account> }
    ],
    "subscriptions": []
  },
  "pubkey": A.pub, "to": Abank.pub }

// to Bbank
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "transfer",
        "promise_hash": <bpromise-hash>,
        "amount": 1,
        "debit_account_hash": <bob-bpromise-account>,
        "credit_account_hash": <alice-bpromise-account> }
    ],
    "subscriptions": []
  },
  "pubkey": A.pub, "to": Bbank.pub }
```

Each bank mints a debit/credit record pair, stores them, and returns the record bodies including ULIDs and `pair` values.

## Phase 1 — Build and submit holder Txs

Alice and Bob each build their own Tx. They share the same `deal` ULID.

**Alice's Tx (ATx):**
```ts
{
  type: "tx",
  pubkey: A.pub,
  ulid: <new>,
  deal: <deal-ulid>,
  records: [<alice-apromise-debit-ulid>, <alice-bpromise-credit-ulid>]
}
```

**Bob's Tx (BTx):**
```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  deal: <deal-ulid>,
  records: [<bob-bpromise-debit-ulid>, <bob-apromise-credit-ulid>]
}
```

Alice signs ATx with `action="lead"`. Bob signs BTx with `action="follow"`.

Alice submits ATx to Abank and Bbank:

```json
// to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <ATx>,
    "holder_signature": <alice-lead-sig>,
    "predecessors": []
  },
  "pubkey": A.pub, "to": Abank.pub }

// to Bbank
{ "method": "submit_tx",
  "params": {
    "tx": <ATx>,
    "holder_signature": <alice-lead-sig>,
    "predecessors": []
  },
  "pubkey": A.pub, "to": Bbank.pub }
```

Abank sees Alice's `lead` signature and that the debit account has enough balance. It issues `ready` on both of its records.

Bbank sees Alice's `lead` signature and that the credit account is within limits. It issues `ready` on both of its records.

Bob submits BTx to Abank and Bbank:

```json
// to Abank
{ "method": "submit_tx",
  "params": {
    "tx": <BTx>,
    "holder_signature": <bob-follow-sig>,
    "predecessors": []
  },
  "pubkey": B.pub, "to": Abank.pub }

// to Bbank
{ "method": "submit_tx",
  "params": {
    "tx": <BTx>,
    "holder_signature": <bob-follow-sig>,
    "predecessors": []
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Abank and Bbank now have valid holder authorization for every record they own.

## Phase 2 — Hold

Because Abank's leg is touched by Alice's `lead` Tx, Abank holds immediately once all its records are `ready`. On the next `submit_tx` call (or a re-submit by Alice or Bob), Abank acquires the hold on Alice's debit account and issues `hold` signatures.

Bbank's leg is touched only by `follow` Txs. Bbank holds only after it sees that Abank has issued `hold`. Alice relays Abank's `hold` signatures to Bbank by re-calling `submit_tx` on Bbank with no new parameters; Bbank sees Abank's `hold` in the signatures it already has (or via subscription) and issues its own `hold`.

## Phase 3 — Settle

Abank is lead. Alice re-submits `submit_tx` to Abank. Abank verifies the leg is held and has no predecessor constraints, applies the balances:

- Alice's Apromise account: `-1`.
- Bob's Apromise account: `+1`.

Abank releases holds and issues record-level `settle` signatures.

Alice relays Abank's `settle` signatures to Bbank and calls `submit_tx` on Bbank with `upstream_settles` containing Abank's settle signatures:

```json
{ "method": "submit_tx",
  "params": {
    "tx": <BTx-or-ATx>,
    "holder_signature": <sig>,
    "predecessors": [Abank.pub],
    "upstream_settles": [<abank-settle-sig>]
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Bbank verifies the upstream settle, applies balances:

- Bob's Bpromise account: `-1`.
- Alice's Bpromise account: `+1`.

Bbank releases holds and issues its own `settle` signatures, citing Abank's settle in `Signature.seen`.

## Result

- Alice owns `+1` Bpromise at Bbank and owes `-1` Apromise at Abank.
- Bob owns `+1` Apromise at Abank and owes `-1` Bpromise at Bbank.
- Both banks have issued verifiable `settle` signatures, with Bbank's settle proving it saw Abank's settle first.
