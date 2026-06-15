# barter.game protocol — banking schema (v1)

> **Banking document types.** This document defines the document types that represent the banking and ledger layer: Promise, Pocket, Account, Record, Tx, Order, Offer, Subscription, and RecordSubscription. See `base.md` for the foundational primitives (BaseDoc, Signature, Address, canonicalization) and `bank-rpc.md` for the bank API contract.

### 5.1 Promise

A unit of value the `pubkey` owner promises to deliver.

```ts
Promise: BaseDoc & {
  type: "promise";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  image_svn?: string;     // inlined square image
  description_md?: string; // markdown
  due?: DateString;       // optional maturity date
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}
```

**`bank` is part of the Promise hash.** Two promises with the same name issued at different banks are different promises.

> **Invariant:** The Promise schema fields and their types are fixed in v1.


### 5.2 Pocket

A holder's logical grouping of accounts. **Pocket bodies never leave the holder's machine** — banks reference pockets only by hash; the name is private.

```ts
Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // local label, typically not public
}
```

> **Invariant:** A bank MUST NOT accept or store Pocket bodies. `Account.pocket` is an opaque hash to the bank.


### 5.3 Account

The issuer bank's record of a holder's stake in a given Promise.

```ts
Account: {
  type: "account";
  holder: Base58PubKey;   // pubkey of the account owner
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  promise: Base58SHA256;  // hash of the Promise this account holds
}
```

Account hash = `base58(sha256(canonical(account_doc)))`.

Because the Account doc has no `ulid`, its hash is deterministic from the triple `(holder, pocket, promise)`. Re-presenting the same Account is idempotent.

There is no separate protocol operation to "open" an account. A user presents an Account doc to the issuing bank, and the bank stores it. The same is true for a user who wants to receive a Promise issued by another bank: they create an Account object for that bank and present it. Account and Pocket docs are NOT signed by the holder; their authority comes from being referenced by holder-signed Txs, Orders, or (for Accounts) by mint records at the issuing bank.

> **Invariant:** The issuer of a Promise is the sole source of truth for balances of that Promise. No other bank may issue or mutate accounts for a Promise it does not own.
> **Invariant:** Account and Pocket docs have no `sig` field. Users sign Promise, Order, Tx, and Address docs; banks sign Record and Offer docs.


### 5.4 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
Record: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // ULID of the peer record (set by the bank at creation)
}
```

A **transfer** is one debit + one credit of the same Promise for the same `amount`: value leaves the debited holder's account and lands in the credited holder's account, both at that Promise's issuer bank. `pair` links the two halves by ULID. Transfers **chain** when the holder credited by one transfer is the holder debited by another — that holder is passing value along (`A → B → C`). The chain may be a line, a ring, or a general graph, spanning one bank or many.

Records are **bank-minted**: the bank assigns their ULIDs and ensures uniqueness. As BaseDocs, they have content hashes. The Tx → record binding lives in `Tx.records[]` (a list of record hashes), and the bank's per-record state tracks state per record. Banks sign `Signature` docs (base.md §5.6) referencing Records by hash; holders do not sign Records directly.


### 5.5 Tx

A **Tx represents a single holder's view of a barter deal**: "What am I giving and what am I getting in this exchange?" Every holder touched by a deal builds and signs **their own Tx**. The Tx contains only the record hashes that touch that holder's accounts. Holders sign **Promise, Order, Tx, and Address** docs; banks sign **Record and Offer** docs. Invoices and cheques are specializations of Order or Offer with one side omitted.

For example, if Alice and Bob exchange promises X (Alice's, at Xbank) and Y (Bob's, at Ybank):

- **ATx** binds the **debit of X** and the **credit of Y** in Alice's accounts — her view of the deal.
- **BTx** binds the **credit of X** and the **debit of Y** in Bob's accounts — his view.
- Xbank sees only that some X moved from one holder to another; it learns nothing about the Y side. Ybank sees the reverse.

```ts
Tx: BaseDoc & {
  type: "tx";
  records: Base58SHA256[];   // ordered list of record hashes touching this holder
  order?: Base58SHA256;      // optional originating Order doc
  offer?: Base58SHA256;      // optional bank-issued derived Offer doc
}
```

`Tx.pubkey` MUST be the owner of **all** accounts referenced by `records`. A Tx may carry at most one of `order` or `offer`; these are alternative authorization sources (see bank-rpc.md §2.1). If a `lead` Order/Offer is referenced, the holder signature on the Tx may be omitted and the bank executes on the Order/Offer alone. An "invoice" is an Order or Offer with `debit` omitted; a "cheque" is an Order or Offer with `credit` omitted.

`records` contains every record hash touching this holder in this deal. That may be a single transfer pair (debit + credit), a pass-through set (multiple debits or credits), or an arbitrary open graph of transfers across one or more banks. Cardinality is **open**.

> **Invariant:** A deal is composed of one signed Tx per participating holder. A bank may therefore receive multiple Txs, each from a different holder, all touching the same records. `Tx.records[]` is unbounded. Any cap on the number of banks, transfer pairs, or holder Txs is an implementation limitation, not a protocol constraint.


### 5.7 Order

A standing instruction that authorizes a bank to process matching **records** on the holder's behalf — an alternative to a per-deal Tx signature. Orders have no expiration; they remain valid as long as the holder maintains sufficient balance in the referenced accounts.

```ts
Order: BaseDoc & {
  type: "order";
  rate: number;             // debit_amount / credit_amount; must be positive
  debit?: {
    account: Base58SHA256;  // account to debit
    promise: Base58SHA256;  // promise being given
    min: number;            // minimum amount to debit per match; prevents fragmentation
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    account: Base58SHA256;  // account to credit
    promise: Base58SHA256;  // promise being received
    min: number;            // minimum amount to credit per match; prevents fragmentation
    max: number;            // maximum amount to credit per match
  };
  credit_account_limit?: number; // maximum amount allowed in the credit account; prevents overstocking
  credit_order_limit?: number;   // maximum cumulative amount processed through this order
  lead: boolean;            // if true, holder authorizes lead role for matched Records
}
```

`Order.pubkey` MUST equal the `holder` field of each referenced Account.

**Specializations.** Omitting one side produces the two authorization shortcuts. These are not separate doc types — they are Orders with a missing side:

- **Invoice** — an Order with `debit` omitted. It authorizes an unconditional credit to the holder; anyone may attach it to a Tx to transfer funds to the invoice holder.
- **Cheque** — an Order with `credit` omitted. It authorizes an unconditional debit from the holder; whoever has the cheque may attach it to a Tx to pull funds.

Public Offers for cheques make sense in airdrop scenarios; public Offers for invoices make sense in fundraising or charity scenarios.

**Order-Record matching.** A pair of Records (credit + debit) matches an Order `O` when all of the following hold:

1. If `O.credit` is present, the credit record's `account` equals `O.credit.account`.
2. If `O.debit` is present, the debit record's `account` equals `O.debit.account`.
3. The debit amount divided by the credit amount equals `O.rate` (within the bank's rounding policy).
4. If `O.credit` is present, the credit amount is between `O.credit.min` and `O.credit.max`.
5. If `O.debit` is present, the debit amount is between `O.debit.min` and `O.debit.max`.
6. The cumulative amount across all Records already matched to `O` does not exceed `O.credit_order_limit` (if set).
7. The resulting balance of the credit account does not exceed `O.credit_account_limit` (if set).
8. If `O.lead` is `false`, the Records must be part of a Tx whose holder signature has `action="follow"`.

If an Order matches, the bank treats it as equivalent to a holder authorization for the purposes of the ready/hold/settle waves (bank-rpc.md §2.0). Matching may happen either because a holder signed a Tx that references the Order, or because a matchmaker called `create_records` with an `offer_match` request against a published Offer derived from the Order. Specifically:

- During **ready**, the holder's bank checks that the `debit` account has enough **free balance** (current balance minus any existing holds) to cover the proposed debit. If yes, the bank issues a `ready` signature on the matched **Records** on behalf of the Order; if no, the bank rejects.
- During **hold**, the bank locks the debit amount as it would for a direct holder signature.
- During **settle**, the bank applies the balance change and releases the hold.

A holder cancels an Order by emptying its `debit` account; the bank then has no available balance to ready against. Because Orders have no expiration, they remain on the ledger indefinitely, limited only by account balance.


### 5.8 Offer

When a bank receives an Order and the referenced Account objects, it MAY create a derived **Offer** doc on behalf of the bank. The Offer exposes the Order's trading terms while hiding the holder's identity and account hashes.

```ts
Offer: BaseDoc & {
  type: "offer";
  pubkey: Base58PubKey;     // bank's pubkey
  order: Base58SHA256;      // hash of the original order
  rate: number;             // debit_amount / credit_amount
  debit?: {
    promise: Base58SHA256;  // promise being given
    min: number;            // minimum amount to debit per match
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    promise: Base58SHA256;  // promise being received
    min: number;            // minimum amount to credit per match
    max: number;            // maximum amount to credit per match
  };
  lead: boolean;            // if true, the order can be executed without explicit credit-holder confirmation
}
```

Banks MAY publish Offers through their public API. Matchmakers and other clients may subscribe to offer streams for particular promises and assemble deals by calling `create_records` with `offer_match` requests. The bank resolves the Offer to the underlying Order, creates records using the Order holder's hidden account and the matchmaker's provided counterparty account, and returns the record bodies. The matchmaker then stitches record hashes from multiple banks into Txs that reference the original Order or Offer hash.

A Tx MAY reference either an `order` hash or an `offer` hash as its authorization source; the bank resolves the underlying Order when validating the records. If the referenced Order/Offer has `lead=true`, the bank executes without requiring a holder signature on the Tx.

Like Orders, Offers may omit one side: an Offer with `debit` omitted is an **invoice offer**, and an Offer with `credit` omitted is a **cheque offer**.

> **Invariant:** Offers are bank-issued derived documents. They are not holder signatures, but they MUST be signed by the bank's pubkey and they MUST accurately reflect the terms of the referenced Order.


### 5.9 Subscription

The initiating party's instruction to a bank: *push the Signature docs you create concerning these items to this URL.* This is how the initiator chooses the deal's delivery topology (bank-rpc.md §2.4).

```ts
Subscription: BaseDoc & {
  type: "subscription";
  hashes?: Base58SHA256[]; // watch keys matching Signature.hash
  url: string;             // http(s) endpoint to POST bank-signed notify envelopes to
  to?: Base58PubKey;       // delivery target behind url (defaults to the creator)
  until?: DateString;      // optional expiry; banks default one (reference: 7 days)
}
```

`pubkey` is the **creator** (who signs the request); `to` is the **delivery target** behind `url` — a peer bank or another party. At least one `hashes` list must be non-empty. When the bank creates a Signature whose `hash` matches a watch key, it POSTs a bank-signed `notify_signatures` JSON-RPC envelope (addressed `to` the target) to `url`.

Fan-out is **fire-and-forget**: no retry, no delivery guarantee, and a failed push never fails the originating request. Client relay (bank-rpc.md §2.4) is the recovery path.

> **Invariant:** The Subscription doc shape and the fire-and-forget semantics are protocol. Push timeout, SSRF hardening (https-only, no redirects), and per-subscriber caps are implementation details — but a bank MUST NOT let fan-out failures affect ledger state.


### 5.10 RecordSubscription

When creating records, the proposing client MAY supply a list of lightweight **RecordSubscription** objects so the bank can immediately fan out signatures on the freshly minted records. A RecordSubscription is not a content-addressed doc; it is a one-off routing hint used only at record-creation time.

```ts
RecordSubscription: {
  record: Base58SHA256;  // hash of the Record to watch
  url: string;            // URL where new signatures on the record should be published
}
```

On receiving a `create_records` call, the bank MAY turn each `RecordSubscription` into a persistent `Subscription` doc (§8) for the requested record. Either way, signatures issued for that record are pushed to the URL. For broader or longer-lived fan-out, clients SHOULD use the `subscribe` method directly.


