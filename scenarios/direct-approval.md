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

Alice generates a shared `deal` ULID and computes the topology: Abank is lead, Bbank is follow with Abank as its predecessor.

Alice calls `create_records` on each bank:

```json
// to Abank
{ "method": "create_records",
  "params": {
    "deal": <deal-ulid>,
    "role": "lead",
    "predecessors": [],
    "banks": [Abank.pub, Bbank.pub],
    "requests": [
      { "type": "transfer",
        "promise_hash": <apromise-hash>,
        "amount": 1,
        "debit_account_hash": <alice-apromise-account>,
        "credit_account_hash": <bob-apromise-account> }
    ],
    "record_subscriptions": [
      { "record": <alice-apromise-debit-ulid>, "url": <bbank-notify-url> },
      { "record": <bob-apromise-credit-ulid>, "url": <bbank-notify-url> }
    ]
  },
  "pubkey": A.pub, "to": Abank.pub }

// to Bbank
{ "method": "create_records",
  "params": {
    "deal": <deal-ulid>,
    "role": "follow",
    "predecessors": [Abank.pub],
    "banks": [Abank.pub, Bbank.pub],
    "requests": [
      { "type": "transfer",
        "promise_hash": <bpromise-hash>,
        "amount": 1,
        "debit_account_hash": <bob-bpromise-account>,
        "credit_account_hash": <alice-bpromise-account> }
    ],
    "record_subscriptions": [
      { "record": <bob-bpromise-debit-ulid>, "url": <abank-notify-url> },
      { "record": <alice-bpromise-credit-ulid>, "url": <abank-notify-url> }
    ]
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
    "holder_signature": <alice-lead-sig>
  },
  "pubkey": A.pub, "to": Abank.pub }

// to Bbank
{ "method": "submit_tx",
  "params": {
    "tx": <ATx>,
    "holder_signature": <alice-lead-sig>
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
    "holder_signature": <bob-follow-sig>
  },
  "pubkey": B.pub, "to": Abank.pub }

// to Bbank
{ "method": "submit_tx",
  "params": {
    "tx": <BTx>,
    "holder_signature": <bob-follow-sig>
  },
  "pubkey": B.pub, "to": Bbank.pub }
```

Abank and Bbank now have valid holder authorization for every record they own.

## Phase 2 — Hold

Abank's leg is touched by Alice's `lead` Tx. Once all its records are `ready`, Abank's advance engine acquires the hold on Alice's debit account and issues a deal-level `hold` Signature.

Bbank's leg is touched only by `follow` Txs. Bbank's advance engine holds only after it sees that Abank has issued `hold`. Abank's `hold` Signature reaches Bbank via subscription fan-out (or client relay with `notify_signatures` if a push is lost). Bbank then acquires its hold on Bob's debit account and issues its own deal-level `hold` Signature.

## Phase 3 — Settle

Abank is lead and has no predecessor dependency. Once Abank has observed a `hold` Signature from Bbank and its own leg is held, its advance engine applies the balances:

- Alice's Apromise account: `-1`.
- Bob's Apromise account: `+1`.

Abank releases holds and issues record-level `settle` Signatures, citing Bbank's `hold` as appropriate.

Bbank is follower. Once it has verified Abank's deal-level `settle` Signature (received via fan-out or client relay from `get_deal` → `notify_signatures`), its advance engine applies balances:

- Bob's Bpromise account: `-1`.
- Alice's Bpromise account: `+1`.

Bbank releases holds and issues its own `settle` Signatures, citing Abank's settle in `Signature.seen`.

## Result

- Alice owns `+1` Bpromise at Bbank and owes `-1` Apromise at Abank.
- Bob owns `+1` Apromise at Abank and owes `-1` Bpromise at Bbank.
- Both banks have issued verifiable `settle` Signatures, with Bbank's settle proving it saw Abank's settle first.
