# barter.game protocol — v1 (Invariant Contract)

> **This document is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in this file. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in this document is an implementation detail — you may change it.
>
> If you are building your own bank or client, read this file first, then see `IMPLEMENTATION.md` for how the reference team chose to build it.

A federated mutual-credit ledger. A deal is a chain of paired credit/debit transfers — one or more holders moving promises among themselves across one or more banks — completed via signed JSON-RPC, ending with every participating bank agreeing on the new balances.

The simplest deal is bilateral: two holders at two banks swap. But the same machinery covers a single holder moving value inside one bank, a three-party ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What never changes: a deal is a set of credit/debit pairs, and one or more **lead** holders hold first and settle first while everyone else follows. See §2.

### Core concepts: Promise, issuer, holder, bank

A **Promise** is a signed, content-addressed document in which one party (the **issuer**) commits to deliver a specific good or service — "1 logo," "1 hour of consulting," "a hand-drawn portrait." The Promise is bound to a single **bank** (an ed25519 keypair operating a ledger) that tracks every unit of that Promise issued, held, and transferred.

- **Issuer**: the owner of the Promise doc (`pubkey` field). The issuer decides what the Promise means, how many exist (`limit`), and when it matures (`due`). The issuer is personally accountable for redemption.
- **Holder**: any user with a positive balance in an Account for that Promise. Holders trade Promises among themselves; they are not accountable for the issuer's delivery, only for their own ledger position.
- **Bank**: the ledger operator whose pubkey appears in `Promise.bank`. The bank is the sole source of truth for balances of that Promise. It issues Accounts, verifies signatures, and applies transfers. It does not guarantee the issuer's performance — that trust is social, out-of-band.

A **transfer** moves a Promise from one holder to another. The debit holder's balance decreases; the credit holder's balance increases. The sum across all Accounts for a given Promise is always zero (or the agreed `limit`).

---

## 1. Trust model

barter.game v1 is built on three behavioral assumptions. They are not enforced by cryptography; they are the social substrate that makes the protocol's risk posture coherent.

1. **Users already know the issuers of the Promises they hold.**  
   Discovery is out of band — DM, in-person, group chat. The protocol does not search for trading partners, rate issuers, or verify delivery.

2. **Trust is socially enforced.**  
   If Alice delivers and Bob ghosts, Alice yells at Bob. The protocol records the deal cryptographically; it does not arbitrate. Recourse is human, not algorithmic.

3. **Bank operators are accountable to their issuers.**  
   Anyone can run a bank, but the issuers who route their Promises through it have a real relationship with the operator. An operator can erase its ledger or abort transactions — there is no cryptographic prevention — but it cannot forge a plausible alternative history alone, because every Tx requires interlinked signatures from multiple independent parties.

> **Extensibility:** Implementers MAY add additional trust, reputation, or audit mechanisms on top of the protocol (e.g., an external attestation layer, a voluntary-reputation miner, or a bank-integrity auditor). Such extensions MUST be backward-compatible: they must not prevent a client and bank from interacting using only the base v1 wire format.

---

## 2. Settlement model — three waves, lead/follow, and visibility

A deal executes in three waves. Each wave is gated independently; waves do not advance until their gate is satisfied, and no wave waits for a different bank's wave.

### 2.0 Three-wave execution model: ready → hold → settle

**1. Ready** — every holder whose accounts are touched by the deal must authorize their part of the deal by signing their own **Tx or Order**. Authorization is independent: Alice can authorize without waiting for Bob. A bank then validates those authorizations and issues a record-level `ready` signature on its own LedgerRecords when it is prepared to proceed. Authorization can come from:

- A direct holder `lead` or `follow` signature on the holder's own **Tx**.
- A matching `Order` doc (§5.7). When a holder is represented by an Order, the holder's bank issues `ready` on the matched Records on the holder's behalf, checking at ready time that the relevant accounts have sufficient free balance.
- A matching `Offer` doc (§5.8) — a bank-issued derivation of an Order. The holder still signs the Tx that references the Offer.
- An invoice or cheque specialization of an Order or Offer (one side omitted, §5.7).

If a bank sees both a direct Tx signature and a matching Order/Offer for the same Records, either one satisfies the ready gate. For a `lead` Order/Offer, the holder signature may be omitted entirely; the bank executes on the Order/Offer alone.

**2. Hold** — once **all authorizations** for a bank's leg are in and the bank has issued `ready` on its records, that bank locks the debit accounts involved in its records. A bank's leg holds when:

- any holder Tx touching its leg is `lead`, **or**
- every holder Tx touching its leg is `follow` AND every predecessor bank whose output those holders depend on has already issued a `hold` signature.

Holds are per-account and per-bank. A `-32003` conflict means some account is already locked by another in-flight deal; the client aborts by calling `reject` everywhere.

**3. Settle** — once **all holds** across the whole deal are in, banks apply balances in dependency order. The settle rule mirrors the hold rule:

- a lead bank settles immediately (its holders accepted the risk of moving first),
- a follow bank settles only after every predecessor bank whose output it depends on has issued a **record-level `settle` signature**, cited in `Signature.seen` (§5.6).

> **Implementation note:** The v1 reference implementation calls `create_records` on each bank, then each holder builds their own Tx and calls `submit_tx` on every bank that owns records touching their accounts. A single `submit_tx` call may issue `ready`, `hold`, and/or `settle` signatures as conditions allow.

### 2.1 Authorization sources

A bank advances a leg only when it has valid authorization — a holder-signed Tx or matching Order/Offer — for every **Record** (credit or debit) touching a holder's account in that leg. The authorization sources, in precedence order:

| Source | Signed target | Role implication |
|---|---|---|
| Holder's `lead`-action Signature | Tx | lead |
| Holder's `follow`-action Signature | Tx | follow |
| Matching Order with `lead=true` | Order | lead |
| Matching Order with `lead=false` | Order | follow |
| Matching `lead` Offer | Offer (referenced by the Tx) | lead; no holder signature required |
| Matching `follow` Offer | Offer (referenced by the Tx) | follow |
| Invoice specialization | Order or Offer with `debit` omitted | follow for the sender |
| Cheque specialization | Order or Offer with `credit` omitted | lead; unconditional debit authorized |

A bank MAY support only direct Tx signatures in v1; Order/Offer matching (including invoice/cheque specializations) are optional forward-compatible extensions. When multiple sources are present, any one suffices.

### 2.2 Risk — lead and follow

A deal settles as an ordered cascade, not a single atomic flip. Each holder's Tx names that holder's role: **lead** or **follow**. The deal's **lead set** is the set of banks whose legs are touched by at least one `lead` Tx. The lead set holds first and settles first; each follower applies its own balance change only after observing the **record-level `settle` signature(s)** of its predecessor(s) in the transfer chain. The follower's own `settle` cites those upstream sigs in `Signature.seen` (§5.6), so the cascade is a verifiable chain — every link proves the prior link committed.

The lead set is whichever holders must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead settles first; the follower settles once the client relays it the lead's `settle`.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A, B}`. After A and B settle, C settles `C → D`, then D settles `D → A` and `D → B`, closing both cycles. No single party could safely lead alone — C's downstream move depends on two upstream settles.

If any downstream bank refuses to apply (compromise, malice, downtime), every participant that already settled is out: their promises moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers choose to wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank sees only its own legs

**No bank ever sees the whole transaction.** A bank sees only the transfers of the promises *it issues* — "this much of my promise leaves holder X; this much arrives at holder Y" — and nothing about the other legs.

This falls straight out of the issuer-authority rule (§5.3, §9): a transfer of promise `P` lives entirely at `P`'s issuer bank (debit and credit are both `P`-accounts there), and every record carries `pubkey = P`'s issuer bank. A bank only ever holds, locks, applies, and signs records whose `pubkey` is its own.

The coordinator is therefore **the proposing client, not a bank.** The client is the one party that legitimately knows the whole deal — it designed it — so it builds the graph and hands each bank only that bank's slice:

- **Bodies it gets:** only the credit/debit records whose promise this bank issues.
- **ULIDs it gets:** the full `records[]` list of each holder Tx presented to it — but these are *ULIDs*, not hashes. A bank needs them to verify that its own records are included in each Tx; it cannot infer another leg's amount, account, holder, or promise from a ULID alone.
- **Routing it gets:** for the settle cascade, the pubkeys of its immediate **predecessor banks** (so it can verify their record-level `settle` signatures, §5.6). It learns *that* a peer bank participates, not *what* that peer transfers.

What a bank can infer is bounded and deliberate: the number of legs (length of `records[]`) and the identities of the banks directly upstream of it. It learns nothing else. **Banks do not call each other during a trade** — the client relays each signature to exactly the bank that needs it.

> **Invariant:** This visibility boundary is load-bearing. Any implementation that lets a bank see another bank's records violates the protocol.

---

## 3. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key.
- **Bank**: a process holding a private key.

There is no separate "address" or "DID"; the pubkey IS the identity.

> **Invariant:** ed25519 + base58 encoding is mandatory for v1 interoperability.

---

## 4. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero → `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

When signing a doc, **the top-level `sig` field is removed** before canonicalization. The hash that the signature commits to is therefore content-addressed by the unsigned doc.

> **Invariant:** Two implementations must produce byte-identical canonical JSON for the same document, or every signature becomes unverifiable across implementations. You MUST implement RFC 8785 (or equivalent JCS) and you MUST verify cross-runtime parity before claiming v1 compatibility.

---

## 5. Document types

All docs share the `BaseDoc` shell:

```ts
type BaseDoc = {
  type: "promise" | "pocket" | "account" | "tx" | "credit" | "debit" | "signature" | "order" | "offer" | "address";
  pubkey: Base58PubKey;   // owner / signer
  ulid: ULID;              // 26-char Crockford base32, generated at creation
}
```

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `YYYY-MM-DD`.

The concrete types:

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

A holder's logical grouping of accounts. Banks reference pockets only by hash; the name is private to the holder.

```ts
Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // local label, typically not public
}
```

### 5.3 Account

The issuer bank's record of a holder's stake in a given Promise. Banks maintain balance and pending state per Account row.

```ts
Account: BaseDoc & {
  type: "account";
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  promise: Base58SHA256;  // hash of the Promise this account holds
}
```

Account hash = `base58(sha256(canonical(account_doc)))`.

There is no separate protocol operation to "open" an account. A user presents a signed Account doc (and the Pocket docs it references) to the issuing bank, and the bank stores it. The same is true for a user who wants to receive a Promise issued by another bank: they create Pocket and Account objects for that bank and present them.

> **Invariant:** The issuer of a Promise is the sole source of truth for balances of that Promise. No other bank may issue or mutate accounts for a Promise it does not own.

### 5.4 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
LedgerRecord: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // ULID of the peer record (set by the bank at creation)
}
```

A **transfer** is one debit + one credit of the same Promise for the same `amount`: value leaves the debited holder's account and lands in the credited holder's account, both at that Promise's issuer bank. `pair` links the two halves by ULID. Transfers **chain** when the holder credited by one transfer is the holder debited by another — that holder is passing value along (`A → B → C`). A Tx is the full set of transfers in one deal; the chain may be a line, a ring, or a general graph, spanning one bank or many.

Records are **bank-minted**: the bank assigns their ULIDs and ensures uniqueness. They are NOT content-addressed. The Tx → record binding lives in `Tx.records[]` (a list of ULIDs), and the bank's per-Tx state tracks state per leg. Banks sign `Signature` docs (§5.6) over Records; holders do not sign Records directly.

### 5.5 Tx

A **Tx represents a single holder's view of a barter deal**: "What am I giving and what am I getting in this exchange?" Every holder touched by a deal builds and signs **their own Tx**. The Tx contains only the LedgerRecord ULIDs that touch that holder's accounts. Holders sign **Tx or Order** docs; banks sign **LedgerRecord or Offer** docs. Invoices and cheques are specializations of Order or Offer with one side omitted.

For example, if Alice and Bob exchange promises X and Y:

- Alice's Tx contains a debit record against her X account and a credit record for her Y account.
- Bob's Tx contains a debit record against his Y account and a credit record for his X account.
- Alice and Bob may not even know each other's identities in the exchange.
- The X issuer bank sees only that some amount of X moved from one holder to another; it learns nothing about the Y side.
- The Y issuer bank sees the reverse.

```ts
Tx: BaseDoc & {
  type: "tx";
  deal: ULID;                // deal identifier shared by every holder Tx in this deal
  records: ULID[];           // ordered list of record ULIDs touching this holder
  order?: Base58SHA256;      // optional originating Order doc
  offer?: Base58SHA256;      // optional bank-issued derived Offer doc
}
```

`Tx.pubkey` MUST be the owner of **all** accounts referenced by `records`. A Tx may carry at most one of `order` or `offer`; these are alternative authorization sources (see §2.1). If a `lead` Order/Offer is referenced, the holder signature on the Tx may be omitted and the bank executes on the Order/Offer alone. An "invoice" is an Order or Offer with `debit` omitted; a "cheque" is an Order or Offer with `credit` omitted.

`records` contains every ULID touching this holder in this deal. That may be a single transfer pair (debit + credit), a pass-through set (multiple debits or credits), or an arbitrary open graph of transfers across one or more banks. Cardinality is **open**.

> **Invariant:** A deal is composed of one signed Tx per participating holder. A bank's leg may therefore receive multiple Txs, each from a different holder. `Tx.records[]` is unbounded. Any cap on the number of banks, transfer pairs, or holder Txs is an implementation limitation, not a protocol constraint.

### 5.6 Signature

Attestations are first-class docs.

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // doc this signature refers to
  action?: "ack" | "ready" | "hold" | "settle" | "reject"
         | "lead" | "follow" | "timeout";
  seen?: Base58Signature[];  // prior sigs this one acknowledges
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```

`pubkey` may be a user OR a bank.

- **Holder signatures** (`action="lead"` or `action="follow"`) are made over **Tx or Order** docs. A `lead` signature on a Tx authorizes the holder's bank to move first; a `follow` signature authorizes the bank to move only after upstream predecessors have settled. An "invoice" or "cheque" is simply an Order with one side omitted. If a Tx references a `lead` Order/Offer, the holder signature may be omitted.
- **Bank signatures** (`action="ready"`, `"hold"`, `"settle"`, `"reject"`) are made over **LedgerRecord** docs. `ready` means the bank has validated the record, checked limits and free balance, and is prepared to proceed. `hold` means the debit account is locked. `settle` means balances have been applied. `reject` means the bank will not proceed; it may be issued from any pre-settled state, and banks MAY re-issue a rejection with an updated `reason` to explain its position. Banks also sign **Offer** docs when deriving them from Orders.

`seen` is the load-bearing field for multi-party settlement: every signature MUST include any prior signatures that were required for this bank to advance the record. A follower bank's `settle` signature lists the upstream bank `settle` signatures it observed before applying its own Records. That turns the flat lead→follow handoff into a verifiable chain — every link proves the prior link committed.

> **Invariant:** `Signature.seen` carries the cascade proof. Any implementation must include upstream settle signatures in a follower's `seen` array, and must verify them before applying balances.

### 5.7 Order

A standing instruction that authorizes a bank to process matching **Records** on the holder's behalf. Orders have no expiration; they remain valid as long as the holder maintains sufficient balance in the referenced accounts.

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

`Order.pubkey` MUST be the same as the owner of the referenced credit and debit accounts.

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

If an Order matches, the bank treats it as equivalent to a holder authorization for the purposes of the ready/hold/settle waves (§2.0). Matching may happen either because a holder signed a Tx that references the Order, or because a matchmaker called `create_records` with an `offer_match` request against a published Offer derived from the Order. Specifically:

- During **ready**, the holder's bank checks that the `debit` account has enough **free balance** (current balance minus any existing holds) to cover the proposed debit. If yes, the bank issues a `ready` signature on the matched **Records** on behalf of the Order; if no, the bank rejects.
- During **hold**, the bank locks the debit amount as it would for a direct holder signature.
- During **settle**, the bank applies the balance change and releases the hold.

A holder cancels an Order by emptying its `debit` account; the bank then has no available balance to ready against. Because Orders have no expiration, they remain on the ledger indefinitely, limited only by account balance.

> **Invariant:** Order docs are first-class, content-addressed, and signed by the holder. A bank MUST verify the Order signature before treating it as authorization. The exact matching arithmetic and rounding policy are implementation details, but they MUST be deterministic and documented.

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

Banks MAY publish Offers through their public API. Matchmakers and other clients may subscribe to offer streams for particular promises and assemble deals by calling `create_records` with `offer_match` requests. The bank resolves the Offer to the underlying Order, creates records using the Order holder's hidden account and the matchmaker's provided counterparty account, and returns the record ULIDs. The matchmaker then stitches ULIDs from multiple banks into Txs that reference the original Order or Offer hash.

A Tx MAY reference either an `order` hash or an `offer` hash as its authorization source; the bank resolves the underlying Order when validating the leg. If the referenced Order/Offer has `lead=true`, the bank executes without requiring a holder signature on the Tx.

Like Orders, Offers may omit one side: an Offer with `debit` omitted is an **invoice offer**, and an Offer with `credit` omitted is a **cheque offer**.

> **Invariant:** Offers are bank-issued derived documents. They are not holder signatures, but they MUST be signed by the bank's pubkey and they MUST accurately reflect the terms of the referenced Order.

### 5.9 RecordSubscription

When creating records, the proposing client supplies a list of **RecordSubscription** objects so that banks can fan out newly issued signatures to interested parties. A RecordSubscription is not a content-addressed doc; it is a routing hint.

```ts
RecordSubscription: {
  record: ULID;           // ULID of the LedgerRecord to watch
  url: string;            // URL where new signatures on the record should be published
}
```

Banks issue signatures on Records and then push them to every subscriber URL provided for that Record. Subscriptions enable both direct bank-to-bank notification and privacy-preserving proxy setups; the party driving the deal decides how much privacy is required.

### 5.10 Address

A bank publishes its current endpoint as a signed **Address** doc. Address docs are indexed by pubkey; a newer Address (by ULID) for the same pubkey replaces the older one.

```ts
Address: BaseDoc & {
  type: "address";
  url?: string;           // current endpoint of the bank
}
```

Banks maintain public directories of Address docs. Anyone MAY update an Address for a pubkey by presenting a signed Address doc with a newer ULID. The canonical discovery endpoint is `.well-known/barter-bank.json` (§10.1); Address docs allow a bank to announce URL changes in a verifiable, self-signed form.

> **Invariant:** Address docs are signed by the bank they describe. A newer ULID overrides an older one for the same pubkey.

---

## 6. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id":       "<ulid>",
  "method":   "<method-name>",
  "params":   { ... },
  "pubkey":   "<sender pubkey>",
  "to":       "<recipient bank pubkey>",
  "sig":      "<base58 sig>"
}
```

- `id` is a ULID claimed in the recipient's replay window.
- `to` binds the request to this specific recipient. A peer bank with a different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by the private key corresponding to `pubkey`.
- For holder-facing methods, `pubkey` is the holder's user pubkey. The trade path has no bank-to-bank JSON-RPC calls; Address-directory endpoints are plain HTTP (§7.5).

### 6.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

> **Invariant:** The envelope shape, the `to` binding, and the replay-protection semantics are protocol. The exact window size, pruning policy, and storage backend are implementation details.

### 6.2 Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (body wasn't JSON) |
| `-32600` | Invalid request (envelope malformed) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | Validation (doc shape, business rule) |
| `-32001` | Signature invalid (`to` mismatch, bad sig) |
| `-32002` | Replay (ULID already seen) |
| `-32003` | Lock conflict (concurrent hold on same account) |
| `-32004` | Timeout (reserved; not used in v1) |
| `-32005` | Unknown doc (referenced hash not in this bank's DB) |

> **Invariant:** These error codes and their meanings are part of the v1 contract. Custom codes MUST use the `-32006..-32099` range.

---

## 7. Bank API

The bank API is **doc-oriented and signature-driven**. Clients present signed documents and document-creation requests; banks store the documents they are shown, mint bank-owned identifiers (record ULIDs and `pair` values), issue their own signatures, and fan out those signatures to subscribers. Banks never advance state on their own — every signature is issued in response to a client call.

The API surface below is intentionally small. The three waves of a deal (ready, hold, settle) are not separate RPC methods; they are different signatures the bank issues on its LedgerRecords as conditions are satisfied.

### 7.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `mint(promise, pockets[], accounts[])` | issuer → issuer bank | Store the Promise, the issuer's Pocket docs, and the two issuer Accounts (negative-balance row and positive-balance row). Issue bank attestation signatures. |
| `submit_account(account, pocket?)` | holder → issuer bank | Store a holder-signed Account (and Pocket if supplied). There is no separate "open account" operation; this is it. |
| `submit_order(order, accounts[], publish_offer?)` | holder → each bank that hosts one of the referenced accounts | Store the Order and the referenced Accounts this bank can verify. If `publish_offer` is true, derive and store an Offer, and make it discoverable. Return the Order hash and, if published, the Offer hash and bank signature. |
| `submit_address(address)` | any → bank | Store or update an Address doc for the pubkey it describes, replacing any older Address by ULID. |

### 7.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records(requests, subscriptions?)` | client → each bank | Mint debit/credit record pairs with bank-assigned ULIDs and `pair` values, store them, attach optional subscriptions for future signature fan-out, and return the record bodies. No balances change at this step. |

A `request` is either:

- `{ type: "transfer", promise_hash, amount, debit_account_hash, credit_account_hash }` — explicit transfer between two known accounts.
- `{ type: "offer_match", offer_hash, amount, account_hash }` — match against a published Offer. The bank resolves the underlying Order, validates that `account_hash` is a valid counterparty account for the requested amount and side, and creates the paired records using the Order holder's account (hidden from the matchmaker) and the provided counterparty account.

The bank validates that all accounts exist, reference the correct Promise, and satisfy the Offer terms (rate, min/max, limits) before minting records.

### 7.3 Authorization and execution

| Method | Caller | Side effect |
|---|---|---|
| `submit_tx(tx, holder_signature?, predecessors?, upstream_settles?, subscriptions?)` | client → each bank that owns records in `tx.records` | Store the Tx and optional holder signature. For every Record this bank owns that is referenced by `tx.records`, evaluate whether the bank can issue `ready`, `hold`, `settle`, or `reject` signatures. `holder_signature` is required unless the Tx references a `lead` Order/Offer that authorizes it. `predecessors` is provided on first submit so the bank knows which upstream `settle` signatures to expect later. Issue every signature whose conditions are met, fan them out to subscribers, and return them to the caller. |
| `reject(deal_id, reason)` | holder → bank | Release any holds this bank acquired for Records referenced by any Tx with this `deal` id; issue `reject` signatures. No rollback after settle. |

`submit_tx` is the single entry point for advancing a bank's leg. It is idempotent: re-submitting the same Tx returns the same signatures without side effects. The bank examines:

1. Is the Tx authorized? Either by a holder signature on the Tx, or by a matching `lead` Order/Offer referenced in `tx.order`/`tx.offer`.
2. For each owned Record in `tx.records`, are the account, Promise, and limits valid?
3. Is there enough free balance in the debit account?
4. Has every other Record in this bank's leg received valid holder authorization?
5. For settlement, are the upstream `settle` signatures present (for follower legs)?

`predecessors` is stored on first receipt and used during settlement to verify upstream `settle` signatures. If subsequent `submit_tx` calls disagree on `predecessors`, the bank rejects the call.

The bank issues signatures as far as it can in one call:

- `ready` — when the Record is valid and authorized.
- `hold` — when every Record in the leg is `ready` and the debit accounts can be locked.
- `settle` — when the leg is `held`, all predecessor `settle` signatures are present (for followers), and balances can be applied.
- `reject` — when the bank will not proceed, optionally re-issuable with an updated `reason`.

On a `-32003` lock conflict during `hold`, the coordinator calls `reject` on every participating bank and aborts the deal.

### 7.4 Read and subscribe

| Method | Caller | Side effect |
|---|---|---|
| `get_promise(promise_hash)` | any → bank | Return the Promise doc body. |
| `get_account_balance(account_hash)` | holder → issuer bank | Return current and pending balance. |
| `list_accounts()` | holder → bank | Return all accounts owned by the sender at this bank, with Promise bodies. |
| `get_signatures(record_ulid)` | any → bank | Return all signatures the bank has issued or stored for the given Record ULID. The Record ULID acts as an access key; this enables polling when push subscriptions fail. |
| `list_offers(promise_hash, intention)` | any → bank | Return Offers for the given Promise and intention (`sell` or `buy`). |
| `get_invoice(hash)` / `get_cheque(hash)` | any → bank | Return the Order or Offer at `hash` if it has the invoice (`debit` omitted) or cheque (`credit` omitted) specialization. |
| `list_promises(filter)` | any → bank | Return Promises the bank chooses to expose (e.g., public, discoverable, or all known). Exact filters are bank policy; the method shape is protocol. |
| `subscribe_signatures(record_ulid, url)` | any → bank | Register a URL to receive new signatures for the given Record ULID. |
| `subscribe_offers(promise_hash, intention, url)` | any → bank | Register a URL to receive new Offers for the given Promise and intention. |

### 7.5 Address directory (REST)

The Address directory uses plain HTTP endpoints rather than the JSON-RPC envelope:

- `GET /address/<pubkey>` — return the Address doc for the pubkey, or `404`.
- `POST /address` — body is a signed Address doc; store it if its ULID is newer than any existing Address for that pubkey.

### 7.6 Orchestration with the doc-oriented API

A deal is a set of transfers. Every holder whose accounts are touched builds and signs **their own Tx** containing only the record ULIDs that touch their accounts. A bank's leg may receive multiple Txs; the bank advances its leg only when every one of its records has valid holder authorization.

#### Phase 0 — Create records

1. **Group record-creation requests by bank.** For each participating bank, collect either explicit transfers or `offer_match` requests against published Offers.
2. **create_records** on every bank with its request list and optional **RecordSubscription** list. For explicit transfers the bank mints records using the provided accounts. For `offer_match` requests the bank resolves the Offer/Order, creates records using the Order holder's account and the matchmaker's counterparty account, and returns the record bodies. The client collects all ULIDs.
3. **Build each holder's / matchmaker's Tx.** Choose a deal ULID and include it in every Tx. For every party touched by the deal, assemble `tx.records` from the ULIDs of records that touch that party's accounts. The Tx `pubkey` MUST be that party. Populate `tx.order` or `tx.offer` if the party is authorizing via an Order or Offer.

#### Phase 1 — Authorize

4. **Sign each Tx.** Every holder creates a `Signature` doc over their own Tx hash with `action="lead"` or `action="follow"`.
5. **submit_tx(tx, holder_signature?, predecessors)** by each holder (or matchmaker, when executing against a `lead` Offer) on every bank that owns records in that Tx. Each bank validates the Tx, verifies the holder signature or a matching `lead` Order/Offer, records `predecessors` for later settlement, checks free balance, and issues every signature whose conditions are met — usually `ready` on the first call.
6. The coordinating client polls `get_signatures` or re-calls `submit_tx` (with no changes) until every bank has issued `ready` on every one of its records. Authorizations are independent and do not wait on each other.

#### Phase 2 — Hold

7. Once every Record in a bank's leg is `ready`, the next `submit_tx` call (by any holder whose Tx touches that leg) causes the bank to acquire holds on its owned debit accounts and issue `hold` signatures.  
   - A bank whose leg is touched by any `lead` Tx holds immediately once all its records are `ready`.  
   - A bank whose leg is touched only by `follow` Txs holds only after every predecessor bank has issued `hold`.
8. On any `-32003` conflict, call `reject(deal_id, reason)` on every participating bank and abort.

#### Phase 3 — Settle

9. Call `submit_tx(tx, holder_signature?, predecessors, upstream_settles)` again in topological order, passing upstream `settle` signatures in `upstream_settles` for follower legs. The bank verifies the predecessor signatures, applies its deltas, releases its holds, and issues its own record-level `settle` (with `seen` = the upstream record-level sigs).
10. The cascade ends when every bank has settled. If a downstream bank refuses, upstream banks remain settled — the lead/follow risk accepted in §2.2.

Because the client is the only holder of the full graph, no bank needs another bank's records, URL, or even existence beyond its immediate predecessors. The doc schemas (`Tx.records[]` is unbounded; `Signature.seen` carries the cascade) and the wire envelope are unchanged from the bilateral case — only the orchestration fans out.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are the protocol. The exact HTTP client library, retry policy, timeout values, and how the client stores the deal graph are implementation details.

---

## 8. State machine (per-bank leg)

Each bank runs its own state machine over each of its legs. A leg is advanced by holders calling `submit_tx` with their own Tx; a single `submit_tx` call may cause the bank to issue `ready`, `hold`, and/or `settle` signatures as far as current conditions allow. A bank never advances on a peer bank's message — only on a holder call carrying the proofs it needs.

```
   per-bank leg state (driven by holders; one machine per bank leg)

        submit_tx ────────────────▶ ┌──────────┐
        (each holder → bank,                      │  ready   │  every owned Record
         this bank's records only)                └────┬─────┘  has valid auth
                                                      │ submit_tx
                              all Records ready &    │ (bank locks debits,
                              no lock conflict       │  issues hold)
                                                      ▼
                                                 ┌──────────┐
                                                 │   held   │  debit accounts locked
                                                 └────┬─────┘
                               submit_tx with       │
                               upstream_settles      │
                               (followers only)      ▼
                                                 ┌──────────┐
                                                 │ settled  │  deltas applied,
                                                 └──────────┘  holds released,
                                                               `settle` signed (seen=upstream)

   The client sequences `submit_tx` calls across banks in topological order: lead
   legs reach `settled` first, then each follower once its predecessors' `settle`s
   are in hand. If a follower's bank refuses, upstream banks are already `settled`
   with no rollback — the lead/follow risk (§2). `reject` ends a leg from any
   pre-`settled` state and releases its holds.
```

> **Invariant:** These states, their transitions, and their preconditions are the protocol. The exact storage representation (SQL table, key-value, in-memory) is an implementation detail.

---

## 9. Concurrency

### 9.1 Double-spend prevention

When `submit_tx` causes a bank to acquire a hold on one of its owned debit accounts, a **concurrent hold attempt against an already-locked account returns `-32003`**. The coordinator then calls `reject(deal_id, ...)` on every participating bank to release any holds acquired so far and rejects the deal. Holds span the full participant set, but each per-account lock is independent and bank-local.

> **Invariant:** At most one active hold per account MUST be enforced. How you enforce it (database unique index, in-memory mutex, optimistic locking) is an implementation detail.

### 9.2 Mutual-credit balance semantics

- **Issuers go negative only through minting.** When an issuer mints a Promise, the bank creates the issuer's negative-balance row as part of `mint`. This is the only protocol path that creates a negative balance. The network owes the negative-balance side nothing; the holder owes the network nothing. Each side is accountable for their own ledger position.
- **No negative balance on holder-authorized transfers.** A transfer Tx authorized by a holder signature or by a holder Order/Offer MUST NOT drive the debit account negative. The bank rejects any Record that would overdraw the account. The `Promise.limit` field is honored if set; otherwise issuance is unbounded.
- **Sum invariant**: across all accounts for a given Promise, balances always sum to zero (or the agreed limit). The bank enforces this on every `settle`.

> **Invariant:** The sum invariant is the load-bearing correctness guarantee of the ledger. Every implementation MUST enforce it on every settle.

---

## 10. Bank discovery + pubkey pinning

### 10.1 Discovery

Banks publish their identity at:

```
GET <bank-url>/.well-known/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use, not necessarily the one they fetched from (banks behind reverse proxies need this).

Banks MAY maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from, sourced from `.well-known` files and from explicitly presented **Address** docs (§5.10). Under the client-orchestrated trade path (§2, §7) banks do not call each other, so peer caching is vestigial on the hot path in v1 — kept for discovery and future bank-to-bank features.

### 10.2 Pubkey pinning (security)

`.well-known` is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see §11).
- `.well-known` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

> **Invariant:** The `.well-known` format and the pinning semantics are protocol. How the client stores its config (flat file, localStorage, OS keychain) is an implementation detail.

### 10.3 Address directory API

In addition to `.well-known`, banks expose a public Address directory:

- `GET /address/<pubkey>` — return the Address doc for the pubkey, or `404` if none is found.
- `POST /address` — create or update the Address doc for the pubkey. The bank stores the Address only if it is signed by the pubkey it describes and its ULID is newer than any existing Address for that pubkey.

This allows a bank to announce URL changes in a self-sovereign way: any party can present a newer signed Address to any bank directory, and the directory replaces the old entry.

---

## 11. Invite strings and deep links

Trade invitations are exchanged OOB. The format:

```
barter://<inviter-pubkey>@<inviter-bank-url>?give=<promise-hash>:<amount>&get=<promise-hash>:<amount>&exp=<unix-seconds>&sig=<inviter-sig>
```

- `inviter-pubkey` (base58): the user proposing the trade.
- `inviter-bank-url`: full RPC URL.
- `give`: what the inviter offers (promise hash + amount).
- `get`: what the inviter wants in return.
- `exp`: Unix seconds; receivers reject after.
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by inviter's pubkey.

Self-validating: the receiver can verify the signature before any network call. Tampering with give/get/bank-url invalidates the sig.

Users share these as short deep links, typically rendered as QR codes. When another user scans the link with a smartphone camera, it opens a bank webapp that suggests creating a new key or logging into an existing app. Inside the app the user adds the promise, address, or issuer to their personal catalog. The exact UX is implementation-specific; the link format and its self-validating property are protocol.

> **Invariant:** The invite string format, its fields, and its self-validating property are protocol. How the invite is conveyed (QR code, NFC, deep link, copy-paste) is an implementation detail.

---

## 12. Protocol design decisions, locked

| Decision | Resolution | Invariant? |
|---|---|---|
| Risk model | Lead/follow per legacy spec; no protocol-level rollback | **Yes** |
| Trust model | Counterparties already know each other; discovery OOB | **Yes** |
| Coordinator pattern | **Client-orchestrated**: the proposing user calls each bank with its own slice and relays signatures; banks never call each other on the trade path | **Yes** |
| Visibility | Each bank sees only the records of the promises it issues + the holder Tx hash lists + its predecessor bank pubkeys; no bank sees the full deal | **Yes** |
| Issuer authority | Issuer is sole source of truth for its Promise's balances | **Yes** |
| Concurrent holds | Rejected `-32003`; first-write-wins on per-Account lock | **Yes** |
| Key recovery | Out of scope (lose key → lose account) | **Yes** |
| Key rotation | Out of scope; redeploy with new secret if compromised | **Yes** |
| Canonicalization | RFC 8785 / JCS; cross-runtime golden vectors | **Yes** |
| Account creation | Accounts are opened by presenting a signed Account doc to the issuing bank; there is no separate protocol operation | **Yes** |
| Promise fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 | **Yes** |
| Tx cardinality | Open: `K ≥ 1` transfer pairs across 1..N banks; bilateral (`K=2`) is the simplest case | **Yes** |
| Tx ownership | **One Tx per participating holder**, containing only records that touch that holder's accounts | **Yes** |
| Holder authorization | Holders sign Tx and Order docs; banks sign LedgerRecord and Offer docs | **Yes** |
| Balance floor | Holder-authorized transfers cannot overdraw the debit account; negative balances are created only by issuer minting | **Yes** |
| Offers | Banks MAY derive and publish Offer docs from Orders; Offers hide holder identity and account hashes | **Yes** |

---

## 13. What the protocol does NOT do

These are out of scope for v1. An implementation MAY add them, but they are not part of the barter.game v1 contract:

- **No web UI.** The protocol is transport-agnostic; a web UI is a client-layer concern.
- **No protocol-level rollback.** If the follow bank goes rogue after the lead settles, the lead is out. Recourse is social.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Promises.** Issued Promises are fungible.
- **No automated settle-cascade retry.** If a downstream `submit_tx` fails, the client retries or the deal stalls with upstream legs already settled — the lead/follow risk (§2), resolved socially. A stuck deal is resolved socially; the protocol provides only `reject` for pre-settled aborts.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No global bank discovery directory.** `.well-known`, Address docs, and direct URL+pubkey pinning are the v1 baseline; a global federated directory is a v1.5+ extension.

---

## 14. Standard vs custom API

The open bank API that ensures interoperability and cross-bank transactions is standardized in this document: document schemas, JSON-RPC envelope, method semantics, invite strings, and discovery formats.

Banks MAY also expose custom API endpoints and UI beyond the standard surface. For example, a bank may choose its own KYC flow, fee model, admin tooling, or web dashboard. Such customizations MUST NOT alter the standard document schemas or the semantics of the methods defined in §7. Different banks may implement the custom layer differently; clients that speak only the standard protocol can still trade across them.

> **Invariant:** Anything required for two independent implementations to interoperate belongs in this protocol document. Anything that is operator-specific or UX-specific belongs in a custom or implementation layer.

---

## 15. Implementing barter.game

If you are building your own bank or client:

1. Read this file cover to cover. Everything here is the contract.
2. See `IMPLEMENTATION.md` for how the reference team built it: Supabase, Edge Functions, Postgres, the CLI, and the specific file map.
3. See `SCHEMA.md` for the v1 reference database schema — useful as a starting point, but you may use any storage that enforces the invariants in §9.
4. See `packages/protocol/src/` for the reference canonicalizer, crypto primitives, and schema validators. You may reuse this code directly (MIT) or reimplement in your language of choice.
