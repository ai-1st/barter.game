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

The same flow works for any number of input/output holders; the Coordinator
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
`submit_docs(..., publish_offers: [<order-hash>])`. The Offers are a
**discovery-only** surface: the Coordinator will scan them, but each Order
carries the canonical hash that actually authorizes records.

### AppleBank

- **Alice** submits a sell-apple cheque Order:
  ```ts
  { type: "order", pubkey: Alice.pub, ulid: <new>, rate: 1,
    debit: { account: <alice-apple>, voucher: <apple>, bank: AppleBank.pub, min: 1, max: 1 },
    lead: true }
  ```
- **Carol** submits an identical sell-apple cheque Order (with `pubkey: Carol.pub`).
- **Anna** submits a buy-apple invoice Order:
  ```ts
  {
    type: "order",
    pubkey: Anna.pub,
    ulid: <new>,
    rate: 1,
    credit: { account: <anna-apple>, voucher: <apple>, bank: AppleBank.pub, min: 1, max: 1 },
    credit_order_limit: 2,
    credit_account_limit: 2,
    lead: true
  }
  ```

AppleBank derives and publishes three Offers. Each Offer's `order` field
points back to the holder's canonical Order hash.

### OrangeBank

- **Anna** submits a sell-orange cheque Order (Anna is the OrangeVoucher
  issuer, so this debit may drive her issuer account negative):
  ```ts
  { type: "order", pubkey: Anna.pub, ulid: <new>, rate: 1,
    debit: { account: <anna-orange>, voucher: <orange>, bank: OrangeBank.pub, min: 1, max: 1 },
    debit_order_limit: 1, lead: true }
  ```
- **Bob** submits a buy-orange invoice Order:
  ```ts
  { type: "order", pubkey: Bob.pub, ulid: <new>, rate: 1,
    credit: { account: <bob-orange>, voucher: <orange>, bank: OrangeBank.pub, min: 1, max: 1 },
    credit_order_limit: 1, lead: true }
  ```

OrangeBank derives and publishes two Offers.

### BananaBank

- **Bob** submits a sell-banana cheque Order (Bob is the BananaVoucher issuer,
  so this debit may drive his issuer account negative):
  ```ts
  {
    type: "order",
    pubkey: Bob.pub,
    ulid: <new>,
    rate: 1,
    debit: { account: <bob-banana>, voucher: <banana>, bank: BananaBank.pub, min: 1, max: 1 },
    debit_order_limit: 2,
    lead: true
  }
  ```
- **Alice** submits a buy-banana invoice Order:
  ```ts
  { type: "order", pubkey: Alice.pub, ulid: <new>, rate: 1,
    credit: { account: <alice-banana>, voucher: <banana>, bank: BananaBank.pub, min: 1, max: 1 },
    credit_order_limit: 1, lead: true }
  ```
- **Carol** submits an identical buy-banana invoice Order (with `pubkey: Carol.pub`).

BananaBank derives and publishes three Offers.

## Phase 2 — Coordinator discovers Orders

The Coordinator scans `list_offers` at each bank for Offers on opposite sides
of the same Voucher that form a mutually acceptable trade. For every Offer it
reads the `order` field to obtain the underlying holder **Order hash** — that
Order hash, never the Offer hash, is what `create_records` will reference.

In this deal the Coordinator resolves the following Order hashes:

| Holder | Side | Order hash |
|---|---|---|
| Alice | sell apple (cheque) | `<alice-sell-apple-order>` |
| Carol | sell apple (cheque) | `<carol-sell-apple-order>` |
| Anna | buy apple (invoice) | `<anna-buy-apple-order>` |
| Anna | sell orange (cheque) | `<anna-sell-orange-order>` |
| Bob | buy orange (invoice) | `<bob-buy-orange-order>` |
| Bob | sell banana (cheque) | `<bob-sell-banana-order>` |
| Alice | buy banana (invoice) | `<alice-buy-banana-order>` |
| Carol | buy banana (invoice) | `<carol-buy-banana-order>` |

## Phase 3 — Coordinator shares Address docs

Each bank needs the signed `Address` docs of every other bank it may call
directly. The Coordinator fetches each bank's current Address with
`get_address` and submits it to the other two banks via `submit_docs`:

```json
// Fetch AppleBank's Address
{ "method": "get_address",
  "params": { "pubkey": AppleBank.pub },
  "pubkey": M.pub, "to": AppleBank.pub }

// Submit it to OrangeBank and BananaBank
{ "method": "submit_docs",
  "params": { "docs": [<applebank-address-doc>] },
  "pubkey": M.pub, "to": OrangeBank.pub }

{ "method": "submit_docs",
  "params": { "docs": [<applebank-address-doc>] },
  "pubkey": M.pub, "to": BananaBank.pub }
```

The Coordinator repeats this for OrangeBank's Address and BananaBank's Address.

## Phase 4 — Coordinator creates records

The Coordinator picks a shared `deal_id` ULID. At each bank it makes one
`create_records` call per debit/credit pair. Every call names the **giver**
Order (whose `debit` side is at this bank) and the **receiver** Order (whose
`credit` side is at this bank), the `amount` of this bank's voucher moved
giver → receiver, and the `counter_amount` of the counterparty voucher used
only for the two-sided rate check. The bank seals `deal_id` and the
Coordinator's pubkey into each record's `RecordDetails`.

These Orders are all one-sided cheques/invoices, so the rate check is skipped;
`counter_amount` is `0`.

### AppleBank — two calls

**Call 1: Alice → Anna (1 apple)**

```json
{
  "method": "create_records",
  "params": {
    "giver":          <alice-sell-apple-order>,
    "receiver":       <anna-buy-apple-order>,
    "amount":         1,
    "counter_amount": 0,
    "deal_id":        <deal-id>
  },
  "pubkey": M.pub, "to": AppleBank.pub
}
```

**Call 2: Carol → Anna (1 apple)**

```json
{
  "method": "create_records",
  "params": {
    "giver":          <carol-sell-apple-order>,
    "receiver":       <anna-buy-apple-order>,
    "amount":         1,
    "counter_amount": 0,
    "deal_id":        <deal-id>
  },
  "pubkey": M.pub, "to": AppleBank.pub
}
```

AppleBank mints two debit records (Alice -1, Carol -1) and two credit records
(Anna +1, +1), all referencing the giver/receiver **Order** hashes via
`Record.order`. Anna's `credit_order_limit: 2` allows the cumulative 2.

### OrangeBank — one call

```json
{
  "method": "create_records",
  "params": {
    "giver":          <anna-sell-orange-order>,
    "receiver":       <bob-buy-orange-order>,
    "amount":         1,
    "counter_amount": 0,
    "deal_id":        <deal-id>
  },
  "pubkey": M.pub, "to": OrangeBank.pub
}
```

OrangeBank mints one debit record (Anna -1 orange) and one credit record
(Bob +1 orange).

### BananaBank — two calls

**Call 1: Bob → Alice (1 banana)**

```json
{
  "method": "create_records",
  "params": {
    "giver":          <bob-sell-banana-order>,
    "receiver":       <alice-buy-banana-order>,
    "amount":         1,
    "counter_amount": 0,
    "deal_id":        <deal-id>
  },
  "pubkey": M.pub, "to": BananaBank.pub
}
```

**Call 2: Bob → Carol (1 banana)**

```json
{
  "method": "create_records",
  "params": {
    "giver":          <bob-sell-banana-order>,
    "receiver":       <carol-buy-banana-order>,
    "amount":         1,
    "counter_amount": 0,
    "deal_id":        <deal-id>
  },
  "pubkey": M.pub, "to": BananaBank.pub
}
```

BananaBank mints two debit records (Bob -1, -1) and two credit records
(Alice +1, Carol +1). Bob's `debit_order_limit: 2` allows the cumulative 2.

Each minted record carries `details.coordinator = M.pub`, the Coordinator that
called `create_records`. Knowing the `deal_id` alone is not enough to advance
these records — the bank will only act on a Mandate signed by this same
coordinator pubkey.

## Phase 5 — Coordinator sends Mandates

A Mandate is scoped **per (Order, bank)**, not per-bank: a deal produces one
Mandate for each Order at each bank that holds records for that Order. The
Coordinator builds each Mandate naming the Order it satisfies and listing only
that bank's records for that Order, signs it, and submits it with
`submit_mandate(mandate, records)` — the signed Mandate plus the record bodies
it lists.

The bank rejects a duplicate Mandate for the same `(deal_id, order)`, and
verifies that every listed record has `details.coordinator == mandate.pubkey`
and `Record.order == mandate.order`.

### AppleBank — three Mandates

```json
// Alice's sell-apple Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <alice-sell-apple-order>,
      "bank":    AppleBank.pub,
      "records": [<alice-debit>],
      "sig":     <M-sig>
    },
    "records": [<alice-debit-body>]
  },
  "pubkey": M.pub, "to": AppleBank.pub }

// Carol's sell-apple Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <carol-sell-apple-order>,
      "bank":    AppleBank.pub,
      "records": [<carol-debit>],
      "sig":     <M-sig>
    },
    "records": [<carol-debit-body>]
  },
  "pubkey": M.pub, "to": AppleBank.pub }

// Anna's buy-apple Order — both credit records satisfy this one Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <anna-buy-apple-order>,
      "bank":    AppleBank.pub,
      "records": [<anna-credit-1>, <anna-credit-2>],
      "sig":     <M-sig>
    },
    "records": [<anna-credit-1-body>, <anna-credit-2-body>]
  },
  "pubkey": M.pub, "to": AppleBank.pub }
```

### OrangeBank — two Mandates

```json
// Anna's sell-orange Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <anna-sell-orange-order>,
      "bank":    OrangeBank.pub,
      "records": [<anna-debit>],
      "sig":     <M-sig>
    },
    "records": [<anna-debit-body>]
  },
  "pubkey": M.pub, "to": OrangeBank.pub }

// Bob's buy-orange Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <bob-buy-orange-order>,
      "bank":    OrangeBank.pub,
      "records": [<bob-credit>],
      "sig":     <M-sig>
    },
    "records": [<bob-credit-body>]
  },
  "pubkey": M.pub, "to": OrangeBank.pub }
```

### BananaBank — three Mandates

```json
// Bob's sell-banana Order — both debit records satisfy this one Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <bob-sell-banana-order>,
      "bank":    BananaBank.pub,
      "records": [<bob-debit-1>, <bob-debit-2>],
      "sig":     <M-sig>
    },
    "records": [<bob-debit-1-body>, <bob-debit-2-body>]
  },
  "pubkey": M.pub, "to": BananaBank.pub }

// Alice's buy-banana Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <alice-buy-banana-order>,
      "bank":    BananaBank.pub,
      "records": [<alice-credit>],
      "sig":     <M-sig>
    },
    "records": [<alice-credit-body>]
  },
  "pubkey": M.pub, "to": BananaBank.pub }

// Carol's buy-banana Order
{ "method": "submit_mandate",
  "params": {
    "mandate": {
      "type": "mandate", "pubkey": M.pub, "ulid": <ulid>,
      "deal_id": <deal-id>,
      "order":   <carol-buy-banana-order>,
      "bank":    BananaBank.pub,
      "records": [<carol-credit>],
      "sig":     <M-sig>
    },
    "records": [<carol-credit-body>]
  },
  "pubkey": M.pub, "to": BananaBank.pub }
```

Across the deal that is **eight Mandates** — one per Order per bank: three at
AppleBank, two at OrangeBank, three at BananaBank.

## Phase 6 — Banks advance

A record advances only when (a) its `(deal, order)` has a Mandate that lists
it, signed by the bound coordinator (`M.pub`), **and** (b) the authorizing
Order is bound. Then the per-record state machine runs ready → hold → settle
exactly as in any other deal.

Banks discover peer banks via the `bank` field on each Order side and use the
Address registry to call each other directly with `notify_signatures` when a
lead/follow chain exists. In this merge/branch scenario every Order is
one-sided, references a single voucher at a single bank, and is `lead: true`,
and every debit is covered locally — Alice and Carol from their existing apple
balances, Anna and Bob from their own issuer accounts (orange and banana). So
no debit waits on an incoming credit, there is no follower, and each bank
settles independently once its own records are ready.

1. **Ready**: every record is covered by a valid Order and a Mandate naming
   that Order, signed by `M.pub`. These Orders are one-sided
   (cheques/invoices), so the aggregate `total_debit / total_credit <= rate`
   check is skipped; the per-side `min`/`max` bounds still apply.
2. **Hold**: debit accounts are locked. Because Bob has **two** banana debit
   records in the same deal, BananaBank aggregates them into a single hold of
   2 bananas on Bob's account (Bob is the banana issuer, so this hold may carry
   his account negative). Alice and Carol each have one apple debit record, so
   AppleBank locks each of their accounts for 1 apple. OrangeBank locks Anna's
   orange issuer account for 1 orange.
3. **Settle**: every Order is `lead: true` and every debit is covered locally,
   so no bank waits on a peer's `hold` or `settle`. Each bank applies its
   deltas and releases the holds independently.

## Why the protocol handles this naturally

- `create_records` is per-pair, so a merge or branch just becomes multiple
  calls at the same bank with the same `deal_id`, each naming the giver and
  receiver **Order** hashes.
- `Mandate.records` is an array, so one Mandate can cover several records that
  satisfy the **same Order** at a bank — Anna's two apple credits and Bob's
  two banana debits each ride a single Mandate.
- `debit_order_limit` / `credit_order_limit` let a holder cap the total
  amount processed through an Order even when it is matched in several
  record pairs.
- The double-spend gate is per-account per-deal, so multiple records in the
  same deal that debit the same account share one aggregated hold instead of
  conflicting with each other.
