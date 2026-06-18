# barter.game protocol — Bank document schemas and ledger semantics

This file defines the banking entities and the ledger invariants that operate on them:

- `Voucher`, `Account`
- `Record`, `Order`, `Offer`, `Confirm`
- `Subscription`, `RecordSubscription`
- Per-record, per-bank state machine
- Concurrency and balance semantics

For the base doc shell, `Signature`, `Address`, canonicalization, and the JSON-RPC envelope, see [`base.md`](./base.md). For the RPC method definitions, see [`bank-rpc.md`](./bank-rpc.md). For the human narrative and trust/settlement models, see [`README.md`](./README.md).

---

## 1. Document types

All docs share the `BaseDoc` shell defined in [`base.md`](./base.md):

```ts
type BaseDoc = {
  type: "voucher" | "account" | "credit" | "debit" | "signature" | "order" | "offer" | "confirm" | "subscription" | "address";
  pubkey: Base58PubKey;
  ulid: ULID;
}
```

### 1.1 Voucher

A unit of value the `pubkey` owner vows to deliver.

```ts
Voucher: BaseDoc & {
  type: "voucher";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  image_svn?: string;     // inlined square image
  description_md?: string; // markdown
  due?: DateString;       // optional maturity date (ISO 8601 datetime)
  expires?: DateString;   // optional expiration date (ISO 8601 datetime)
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}
```

**`bank` is part of the Voucher hash.** Two vouchers with the same name issued at different banks are different vouchers.

> **Invariant:** The Voucher schema fields and their types are fixed in v1.

### 1.2 Account

A holder's named bucket. Accounts are BaseDocs, signed by the holder, and **stored by the bank** so the bank can validate that any record referencing the account belongs to the account's owner. The `name` remains private to the holder.

```ts
Account: BaseDoc & {
  type: "account";
  name: string;           // local label, typically not public
  voucher: Base58SHA256;  // hash of the Voucher this account holds
}
```

`Account.pubkey` is the holder. `Account.ulid` uniquely identifies this account. The holder signs the Account doc; the bank stores it by hash after verifying the signature.

> **Invariant:** A bank MUST reject a record whose `details.account` hash does not resolve to a stored Account owned by the record's holder. Account names are private, but the Account doc itself is part of the bank's verified state.

### 1.3 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
Record: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  order: Base58SHA256;    // hash of the Order/Offer doc that authorizes this record
  details: Base58SHA256;  // hash of the bank-internal record details
}

RecordDetails {
  pair: ULID;             // ULID of the peer record (set by the bank at creation)
  deal_id: ULID;          // deal-wide identifier supplied by the matchmaker
  holder: Base58PubKey;   // pubkey of the holder
  account: Base58SHA256;  // hash of holder's Account doc
}
```

A **transfer** is one debit + one credit of the same Voucher for the same `amount`: value leaves the debited holder's account and lands in the credited holder's account, both at that Voucher's issuer bank. `pair` links the two halves by ULID. Transfers **chain** when the holder credited by one transfer is the holder debited by another — that holder is passing value along (`A → B → C`). The chain may be a line, a ring, or a general graph, spanning one bank or many.

Records are **bank-minted**: the bank assigns their ULIDs and ensures uniqueness. As BaseDocs, they have content hashes. The Order → record binding lives in `Record.order`. Banks sign `Signature` docs (see `base.md`) referencing Records by hash; holders do not sign Records directly.

For a normal transfer, the debit record references the giver's Order and the credit record references the receiver's Order. A bank MUST verify that every record it approves is covered by a valid Order, and for paired records it MUST verify that the referenced Orders describe mutually consistent terms and amounts.

### 1.4 Order

A **signed instruction that authorizes a bank to process specific records on the holder's behalf**. Orders are the only holder authorization primitive in v1. A holder creates an Order describing what they are willing to give and/or receive, signs it, and presents it to every bank that issues a Voucher referenced by the Order.

```ts
Order: BaseDoc & {
  type: "order";
  rate: number;             // debit_amount / credit_amount; must be positive
  debit?: {
    account: Base58SHA256;  // account to debit
    voucher: Base58SHA256;  // voucher being given
    min: number;            // minimum amount to debit per match; prevents fragmentation
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    account: Base58SHA256;  // account to credit
    voucher: Base58SHA256;  // voucher being received
    min: number;            // minimum amount to credit per match; prevents fragmentation
    max: number;            // maximum amount to credit per match
  };
  debit_order_limit?: number;    // maximum cumulative debit amount processed through this order
  credit_order_limit?: number;   // maximum cumulative credit amount processed through this order
  debit_account_limit?: number;  // minimum balance allowed on the debit account (optional floor)
  credit_account_limit?: number; // maximum balance allowed in the credit account; prevents overstocking
  lead: boolean;            // if true, holder authorizes lead role for matched Records
}
```

`Order.pubkey` MUST equal `pubkey` of each referenced Account.

When a bank receives an Order, it MUST validate the `rate`:

- `rate` MUST be a positive number.
- `rate` is the **maximum acceptable ratio of debit voucher to credit voucher**. For any matched pair of amounts, `debit_amount / credit_amount` MUST be `<= rate` (within the bank's rounding policy).
- If the Order is one-sided (invoice or cheque), `rate` is informational and MUST still be positive.

An Order may reference Vouchers at **different banks**. The holder submits the same signed Order to each of those banks; each bank checks only the side that involves a Voucher it issues. For example, an Order that says "give Alice-coin, get Bob-coin" is submitted to both Alice's bank and Bob's bank.

**`lead` flag.** `lead: true` means the holder authorizes their bank to act as the **lead party** in any deal where this Order is matched: the lead bank may hold and settle its records before peer banks have locked or settled. `lead: false` means the holder's bank is a **follower**: it must wait for the lead bank's `hold` signature before locking its own debit accounts, and for the lead bank's `settle` signature before settling. A bank learns which peer bank is lead by inspecting the `lead` flag on the Orders it has stored; in a two-bank swap, the bank whose holder's Order is `lead=true` is the lead bank.

**Specializations.** Omitting one side produces the two authorization shortcuts. These are not separate doc types — they are Orders with a missing side:

- **Invoice** — an Order with `debit` omitted. It authorizes an unconditional credit to the holder; anyone may attach it to a transfer to move funds to the invoice holder.
- **Cheque** — an Order with `credit` omitted. It authorizes an unconditional debit from the holder; whoever has the cheque may attach it to a transfer to pull funds.

Public Offers for cheques make sense in airdrop scenarios; public Offers for invoices make sense in fundraising or charity scenarios.

**Order-Record matching.** A Record `R` matches an Order `O` when all of the following hold:

1. `R.order` resolves to a valid Order/Offer `O`.
2. `R` is a `debit` record and `O.debit` is present, OR `R` is a `credit` record and `O.credit` is present.
3. `R.details.holder` equals `O.pubkey`.
4. If `R` is a debit, `R.details.account` equals `O.debit.account`.
5. If `R` is a credit, `R.details.account` equals `O.credit.account`.
6. `R.amount` is between the corresponding `min` and `max`.
7. If `O` is two-sided and the paired record's amount is known, the ratio of the debit amount to the credit amount in the matched pair is `<= O.rate` (within the bank's rounding policy). This is the same ratio whether `O` is on the debit side or the credit side of the pair.
8. The cumulative debit amount across all Records already matched to `O` does not exceed `O.debit_order_limit` (if set).
9. The cumulative credit amount across all Records already matched to `O` does not exceed `O.credit_order_limit` (if set).
10. The resulting balance of the debit account does not fall below `O.debit_account_limit` (if set).
11. The resulting balance of the credit account does not exceed `O.credit_account_limit` (if set).

If an Order matches, the bank treats it as equivalent to a holder authorization for the purposes of the ready/hold/settle waves. Specifically:

- During **ready**, the holder's bank checks that the `debit` account has enough **free balance** (current balance minus any existing holds) to cover the proposed debit, unless the holder is the issuer authorizing a debit from the issuer account. If yes, the bank issues a `ready` signature on the matched **Record** on behalf of the Order; if no, the bank rejects.
- During **hold**, the bank locks the debit amount as it would for any authorized record.
- During **settle**, the bank applies the balance change and releases the hold.

A holder cancels an Order by emptying its `debit` account; the bank then has no available balance to ready against. Because Orders have no expiration, they remain on the ledger indefinitely, limited only by account balance.

### 1.5 Offer

When a bank receives an Order and the referenced Account objects, it MAY create a derived **Offer** doc on behalf of the bank. The Offer exposes the Order's trading terms while hiding the holder's identity and account hashes.

```ts
Offer: BaseDoc & {
  type: "offer";
  pubkey: Base58PubKey;     // bank's pubkey
  order: Base58SHA256;      // hash of the original order
  rate: number;             // debit_amount / credit_amount
  debit?: {
    voucher: Base58SHA256;  // voucher being given
    min: number;            // minimum amount to debit per match
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    voucher: Base58SHA256;  // voucher being received
    min: number;            // minimum amount to credit per match
    max: number;            // maximum amount to credit per match
  };
  lead: boolean;            // copied from the original Order: true if the represented Order is lead
}
```

Banks MAY publish Offers through their public API. Matchmakers discover compatible Offers and ask banks to create record pairs by referencing the Offer hashes.

A Record's `order` MAY reference either an `order` hash or an `offer` hash as its authorization source; the bank resolves the underlying Order when validating the record. The `lead` flag on the resolved Order/Offer tells the bank whether its records are in the lead set for the deal.

Like Orders, Offers may omit one side: an Offer with `debit` omitted is an **invoice offer**, and an Offer with `credit` omitted is a **cheque offer**.

> **Invariant:** Offers are bank-issued derived documents. They are not holder signatures, but they MUST be signed by the bank's pubkey and they MUST accurately reflect the terms of the referenced Order.

### 1.6 Confirm

A matchmaker-signed clearance that tells one bank: "record creation for this deal is complete, and the listed records are the ones you should act on." Banks do not advance records until they receive a `Confirm` that covers them.

```ts
Confirm: BaseDoc & {
  type: "confirm";
  deal_id: ULID;            // deal-wide id supplied by the matchmaker
  bank: Base58PubKey;       // the bank this Confirm is addressed to
  records: Base58SHA256[];  // all record hashes this bank created for the deal
}
```

`Confirm.pubkey` is the matchmaker. `Confirm.sig` is the matchmaker's signature over the canonical unsigned doc.

When a bank receives a `Confirm`:

1. Verify the matchmaker's signature.
2. Verify `Confirm.bank` equals the bank's own pubkey.
3. Verify that every Record it created for `Confirm.deal_id` appears in `Confirm.records`.
4. Only then may the bank advance those records out of `created`, and only once valid Orders are also bound.

The matchmaker sends a different `Confirm` to each participating bank. A bank never needs the full chain's records — only its own slice.

### 1.7 Subscription

A persistent request for a bank to push signatures that match a filter to a given URL.

```ts
Subscription: BaseDoc & {
  type: "subscription";
  url: string;              // where to POST matching signatures
  record?: Base58SHA256;    // watch a single record hash
  holder?: Base58PubKey;    // watch all records touching this holder at this bank
  voucher?: Base58SHA256;   // watch all records for this voucher at this bank
}
```

When the bank issues or receives a Signature that matches a Subscription, it POSTs a bank-signed `notify_signatures` envelope to `url` fire-and-forget. The receiver verifies the bank signature and the contained Signatures independently.

### 1.8 RecordSubscription

When creating records, the proposing client MAY supply a list of lightweight **RecordSubscription** objects so the bank can immediately fan out signatures on the freshly minted records. A RecordSubscription is not a content-addressed doc; it is a one-off routing hint used only at record-creation time.

```ts
RecordSubscription: {
  record: Base58SHA256;  // hash of the Record to watch
  url: string;            // URL where new signatures on the record should be published
}
```

On receiving a `create_records` call, the bank MAY turn each `RecordSubscription` into a persistent `Subscription` doc (§1.7) for the requested record. Either way, signatures issued for that record are pushed to the URL. For broader or longer-lived fan-out, clients SHOULD use the `subscribe` method directly.

---

## 2. State machine (per-record, per-bank)

Each bank runs its own state machine over each record it owns. Records are created by the matchmaker via `create_records`; they stay in `created` until both (a) valid Orders are bound and (b) a per-bank `Confirm` arrives. From `approved` onward the bank advances **itself**, re-evaluating on every event (a `submit_docs` binding an Order, a verified signature arriving via `notify_signatures`).

```
   per-record state (per bank)

   created ── create_records ──▶ all records minted

   submit_docs + submit_confirm (by matchmaker/holders → bank)
        │
        ▼
   ┌──────────┐
   │ approved │  every owned Record has a valid Order bound,
   └────┬─────┘  the per-bank Confirm is received, and records are `ready`
        │        (if `lead` or no predecessors, advance engine runs immediately)
        │ advance engine
        │ all records ready, no lock conflict
        ▼
   ┌──────────┐
   │  held    │  debit accounts locked; `hold` signatures issued and fanned out
   └────┬─────┘
        │ advance engine
        │ for `follow` records: predecessor `settle` signatures present
        │ for `lead` records: no predecessor dependency
        ▼
   ┌──────────┐
   │ settled  │  deltas applied, holds released, `settle` signed
   └──────────┘   (seen = upstream record-level settles for follower records)

   Any pre-settled state can transition to rejected via a bank-issued `reject` signature on the record.
```

The matchmaker is the only party that calls `create_records`. Holders submit Orders (or rely on previously submitted Orders / published Offers). The matchmaker then sends a `Confirm` to each bank once record creation is complete. After that, the bank's advance engine takes over, locking when safe, settling when safe, and emitting signatures. The matchmaker **does** need to ensure every bank eventually receives the signatures its predecessors emit; fan-out subscriptions do this automatically, and `get_record_signatures` + `notify_signatures` is the recovery path.

> **Invariant:** These states, their transitions, and their preconditions are protocol. The storage representation and the event loop that drives self-advancement are implementation details — but a bank MUST NOT settle without its lead/follow precondition met, and MUST NOT apply a record's delta twice.

---

## 3. Concurrency

### 3.1 Double-spend prevention

When the advance engine attempts to acquire a hold on a debit account, it aggregates all records of the **same deal** that debit that account and locks the **total** amount once. If that account is already locked by a **different** deal, the hold attempt returns `-32003` for the record. The affected bank fans out the conflict signature; the coordinator (or any participant) may call `reject` on individual records to release holds and abort. Holds span the full participant set, but each per-account lock is independent and bank-local.

The approve-time balance check is computed net of active holds, so a deal cannot be approved against balance that another in-flight deal has locked.

> **Invariant:** At most one active hold per account per external deal MUST be enforced. Multiple records of the same deal that debit the same account share a single aggregated hold. How (database unique index keyed by account+deal, mutex, optimistic locking) is an implementation detail.

### 3.2 Mutual-credit balance semantics

- **Issuers may start trading without a mint step.** An issuer's own Order can debit the issuer account, driving it negative. This negative balance represents vouchers the issuer owes the network. The first trade creates the issuer's negative row and a corresponding positive row in the buyer's account in one debit/credit pair.
- **No negative balance on non-issuer holder-authorized transfers.** A transfer authorized by a non-issuer holder Order or by a holder Order/Offer MUST NOT drive the debit account negative. The bank rejects any Record that would overdraw the account. The `Voucher.limit` field is honored if set; otherwise issuance is unbounded.
- **Sum invariant**: across all accounts for a given Voucher, balances always sum to zero (or the agreed limit). The bank enforces this on every `settle`.

> **Invariant:** The sum invariant is the load-bearing correctness guarantee of the ledger. Every implementation MUST preserve it on every settle.
