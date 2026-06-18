# Merge-and-branch exchange

This scenario exercises a deal that is **not** a simple 1:1 bilateral swap.
Instead it merges value from multiple holders on one voucher and branches it
out to multiple holders on another voucher.

- **Anna** receives 1 apple from each of two apple holders and gives 1 orange
  to Bob.
- **Bob** receives 1 orange from Anna and gives 1 banana to each of the two
  apple holders.

Net result:

- Anna: +2 apples, -1 orange.
- Bob: +1 orange, -2 bananas.
- Each apple holder: -1 apple, +1 banana.

The same flow works for any number of input/output holders; the matchmaker
splits it into one `create_records` call per debit/credit pair at each bank.

---

## Participants and vouchers

| Holder | Bank / Voucher | Role in this deal |
|---|---|---|
| Anna | OrangeBank (OrangeVoucher issuer) | gives 1 orange |
| Anna | AppleBank (AppleVoucher) | receives 2 apples |
| Bob | BananaBank (BananaVoucher issuer) | gives 2 bananas |
| Bob | OrangeBank (OrangeVoucher) | receives 1 orange |
| Alice | AppleBank (AppleVoucher) | gives 1 apple |
| Alice | BananaBank (BananaVoucher) | receives 1 banana |
| Carol | AppleBank (AppleVoucher) | gives 1 apple |
| Carol | BananaBank (BananaVoucher) | receives 1 banana |

## Phase 1 — Holders publish intent

Each holder signs their Orders and the referenced Account docs and submits
them to every bank that issues a Voucher the Order touches, using
`submit_docs(..., publish_offers: [<order-hash>])`.

### AppleBank

- **Alice** submits a sell-apple cheque Order:
  ```ts
  { type: "order", debit: { account: <alice-apple>, voucher: <apple>, min: 1, max: 1 } }
  ```
- **Carol** submits an identical sell-apple cheque Order.
- **Anna** submits a buy-apple invoice Order:
  ```ts
  {
    type: "order",
    credit: { account: <anna-apple>, voucher: <apple>, min: 1, max: 1 },
    credit_order_limit: 2,
    credit_account_limit: 2
  }
  ```

AppleBank derives and publishes three Offers.

### OrangeBank

- **Anna** submits a sell-orange cheque Order:
  ```ts
  { type: "order", debit: { account: <anna-orange>, voucher: <orange>, min: 1, max: 1 }, debit_order_limit: 1 }
  ```
- **Bob** submits a buy-orange invoice Order:
  ```ts
  { type: "order", credit: { account: <bob-orange>, voucher: <orange>, min: 1, max: 1 }, credit_order_limit: 1 }
  ```

OrangeBank derives and publishes two Offers.

### BananaBank

- **Bob** submits a sell-banana cheque Order:
  ```ts
  {
    type: "order",
    debit: { account: <bob-banana>, voucher: <banana>, min: 1, max: 1 },
    debit_order_limit: 2
  }
  ```
- **Alice** submits a buy-banana invoice Order:
  ```ts
  { type: "order", credit: { account: <alice-banana>, voucher: <banana>, min: 1, max: 1 }, credit_order_limit: 1 }
  ```
- **Carol** submits an identical buy-banana invoice Order.

BananaBank derives and publishes three Offers.

## Phase 2 — Matchmaker creates records

The matchmaker picks a shared `deal_id` ULID. At each bank it makes one
`create_records` call per debit/credit pair.

### AppleBank — two calls

**Call 1: Alice → Anna (1 apple)**

```json
{
  "method": "create_records",
  "params": {
    "offer1": { "hash": <alice-sell-apple-offer>, "debit_amount": 1, "credit_amount": 0 },
    "offer2": { "hash": <anna-buy-apple-offer>,   "debit_amount": 0, "credit_amount": 1 },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": AppleBank.pub
}
```

**Call 2: Carol → Anna (1 apple)**

```json
{
  "method": "create_records",
  "params": {
    "offer1": { "hash": <carol-sell-apple-offer>, "debit_amount": 1, "credit_amount": 0 },
    "offer2": { "hash": <anna-buy-apple-offer>,   "debit_amount": 0, "credit_amount": 1 },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": AppleBank.pub
}
```

AppleBank creates two debit records (Alice -1, Carol -1) and two credit
records (Anna +1, +1). Anna's `credit_order_limit` allows the cumulative 2.

### OrangeBank — one call

```json
{
  "method": "create_records",
  "params": {
    "offer1": { "hash": <anna-sell-orange-offer>, "debit_amount": 1, "credit_amount": 0 },
    "offer2": { "hash": <bob-buy-orange-offer>,    "debit_amount": 0, "credit_amount": 1 },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": OrangeBank.pub
}
```

OrangeBank creates one debit record (Anna -1 orange) and one credit record
(Bob +1 orange).

### BananaBank — two calls

**Call 1: Bob → Alice (1 banana)**

```json
{
  "method": "create_records",
  "params": {
    "offer1": { "hash": <bob-sell-banana-offer>, "debit_amount": 1, "credit_amount": 0 },
    "offer2": { "hash": <alice-buy-banana-offer>, "debit_amount": 0, "credit_amount": 1 },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": BananaBank.pub
}
```

**Call 2: Bob → Carol (1 banana)**

```json
{
  "method": "create_records",
  "params": {
    "offer1": { "hash": <bob-sell-banana-offer>, "debit_amount": 1, "credit_amount": 0 },
    "offer2": { "hash": <carol-buy-banana-offer>, "debit_amount": 0, "credit_amount": 1 },
    "deal_id": <deal-id>
  },
  "pubkey": M.pub, "to": BananaBank.pub
}
```

BananaBank creates two debit records (Bob -1, -1) and two credit records
(Alice +1, Carol +1). Bob's `debit_order_limit: 2` allows the cumulative 2.

## Phase 3 — Matchmaker sends Confirm

The matchmaker builds one `Confirm` per bank listing every record that bank
created for `deal_id`:

- **AppleBank Confirm**: `[<alice-debit>, <carol-debit>, <anna-credit-1>, <anna-credit-2>]`
- **OrangeBank Confirm**: `[<anna-debit>, <bob-credit>]`
- **BananaBank Confirm**: `[<bob-debit-1>, <bob-debit-2>, <alice-credit>, <carol-credit>]`

## Phase 4 — Banks advance

Once each bank has the `Confirm` and the Orders bound to its records, the
advance engine runs:

1. **Ready**: every record is covered by a valid Order.
2. **Hold**: debit accounts are locked. Because Bob has **two** banana debit
   records in the same deal, BananaBank aggregates them into a single hold of
   2 bananas on Bob's account. Alice and Carol each have one apple debit
   record, so AppleBank locks each of their accounts for 1 apple.
3. **Settle**: all preconditions are local, so each bank applies its deltas
   and releases the holds.

## Why the protocol handles this naturally

- `create_records` is per-pair, so a merge or branch just becomes multiple
  calls at the same bank with the same `deal_id`.
- `Confirm.records` is an array, so one `Confirm` can cover an arbitrary
  number of records at a bank.
- `debit_order_limit` / `credit_order_limit` let a holder cap the total
  amount processed through an Order even when it is matched in several
  record pairs.
- The double-spend gate is per-account per-deal, so multiple records in the
  same deal that debit the same account share one aggregated hold instead of
  conflicting with each other.
