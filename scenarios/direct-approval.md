# Scenario: Direct Approval Bilateral Swap

Alice and Bob swap vouchers directly. Alice gives 1 Avoucher (issued by Abank) and receives 1 Bvoucher (issued by Bbank). Bob gives 1 Bvoucher and receives 1 Avoucher. Alice acts as lead; Bob follows.

## Setup

- Alice: user keypair `A.pub`.
- Bob: user keypair `B.pub`.
- Abank: bank keypair `Abank.pub`, issues Avoucher.
- Bbank: bank keypair `Bbank.pub`, issues Bvoucher.
- All parties already have Accounts for the vouchers they will receive, created via `submit_account`.

## Phase 0 — Create records

Alice (the coordinator) builds two explicit transfers:

1. At Abank: debit Alice's Avoucher account, credit Bob's Avoucher account, amount `1`.
2. At Bbank: debit Bob's Bvoucher account, credit Alice's Bvoucher account, amount `1`.

Alice calls `create_records` on each bank:

```json
// to Abank
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "transfer",
        "voucher_hash": <avoucher-hash>,
        "amount": 1,
        "debit_account_hash": <alice-avoucher-account>,
        "credit_account_hash": <bob-avoucher-account> }
    ],
    "record_subscriptions": [
      { "record": <alice-avoucher-debit-hash>, "url": <bbank-notify-url> },
      { "record": <bob-avoucher-credit-hash>, "url": <bbank-notify-url> }
    ]
  },
  "pubkey": A.pub, "to": Abank.pub }

// to Bbank
{ "method": "create_records",
  "params": {
    "requests": [
      { "type": "transfer",
        "voucher_hash": <bvoucher-hash>,
        "amount": 1,
        "debit_account_hash": <bob-bvoucher-account>,
        "credit_account_hash": <alice-bvoucher-account> }
    ],
    "record_subscriptions": [
      { "record": <bob-bvoucher-debit-hash>, "url": <abank-notify-url> },
      { "record": <alice-bvoucher-credit-hash>, "url": <abank-notify-url> }
    ]
  },
  "pubkey": A.pub, "to": Bbank.pub }
```

Each bank mints a debit/credit record pair, stores them, and returns the record bodies including hashes and `pair` values.

## Phase 1 — Build and submit holder Txs

Alice and Bob each build their own Tx containing the record hashes that touch their accounts.

**Alice's Tx (ATx):**
```ts
{
  type: "tx",
  pubkey: A.pub,
  ulid: <new>,
  records: [<alice-avoucher-debit-hash>, <alice-bvoucher-credit-hash>]
}
```

**Bob's Tx (BTx):**
```ts
{
  type: "tx",
  pubkey: B.pub,
  ulid: <new>,
  records: [<bob-bvoucher-debit-hash>, <bob-avoucher-credit-hash>]
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

Abank's records are touched by Alice's `lead` Tx. Once all its records are `ready`, Abank's advance engine acquires the hold on Alice's debit account and issues record-level `hold` Signatures.

Bbank's records are touched only by `follow` Txs. Bbank's advance engine holds only after it sees that Abank has issued `hold` on its own records. Abank's `hold` Signatures reach Bbank via subscription fan-out (or client relay with `notify_signatures` if a push is lost). Bbank then acquires its hold on Bob's debit account and issues its own record-level `hold` Signatures.

## Phase 3 — Settle

Abank is lead and has no predecessor dependency. Once Abank has observed record-level `hold` Signatures from Bbank on the corresponding records, its advance engine applies the balances:

- Alice's Avoucher account: `-1`.
- Bob's Avoucher account: `+1`.

Abank releases holds and issues record-level `settle` Signatures, citing Bbank's `hold` as appropriate in `Signature.seen`.

Bbank is follower. Once it has verified Abank's record-level `settle` Signatures (received via fan-out or client relay from `get_record_signatures` → `notify_signatures`), its advance engine applies balances:

- Bob's Bvoucher account: `-1`.
- Alice's Bvoucher account: `+1`.

Bbank releases holds and issues its own `settle` Signatures, citing Abank's settle in `Signature.seen`.

## Result

- Alice owns `+1` Bvoucher at Bbank and owes `-1` Avoucher at Abank.
- Bob owns `+1` Avoucher at Abank and owes `-1` Bvoucher at Bbank.
- Both banks have issued verifiable `settle` Signatures, with Bbank's settle proving it saw Abank's settle first.
