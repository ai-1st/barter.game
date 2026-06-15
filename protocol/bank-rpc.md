# barter.game protocol — bank RPC (v1)

> **Bank RPC contract.** This document defines the settlement model, trust model, bank API methods, state machine, concurrency rules, discovery, and invite strings. See `base.md` for foundational primitives (BaseDoc, Signature, Address, canonicalization, JSON-RPC envelope) and `bank-schema.md` for banking document types.

> **This document is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in this file. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in this document is an implementation detail — you may change it.
>
> If you are building your own bank or client, read this file first, then see `IMPLEMENTATION.md` for how the reference team chose to build it. `MASTER-INPUT.md` is the source-of-truth design narrative from the product owner; `scenarios/*.md` are step-by-step interaction traces.

A federated mutual-credit ledger. A deal is a chain of paired credit/debit transfers — one or more holders moving promises among themselves across one or more banks — completed via signed JSON-RPC, ending with every participating bank agreeing on the new balances.

The simplest deal is bilateral: two holders at two banks swap. But the same machinery covers a single holder moving value inside one bank, a three-party ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What never changes: a deal is a set of credit/debit pairs, each holder authorizes their own view of it by signing **their own Tx**, and one or more **lead** banks settle first while everyone else follows. See §2.

### Core concepts: Promise, issuer, holder, bank

A **Promise** is a signed, content-addressed document in which one party (the **issuer**) commits to deliver a specific good or service — "1 logo," "1 hour of consulting," "a hand-drawn portrait." The Promise is bound to a single **bank** (an ed25519 keypair operating a ledger) that tracks every unit of that Promise issued, held, and transferred.

- **Issuer**: the owner of the Promise doc (`pubkey` field). The issuer decides what the Promise means, how many exist (`limit`), and when it matures (`due`). The issuer is personally accountable for redemption.
- **Holder**: any user with a positive balance in an Account for that Promise. Holders trade Promises among themselves; they are not accountable for the issuer's delivery, only for their own ledger position.
- **Bank**: the ledger operator whose pubkey appears in `Promise.bank`. The bank is the sole source of truth for balances of that Promise. It stores the docs presented to it, verifies signatures, and applies transfers. **The only artifacts a bank creates are ledger records and signatures.** It does not guarantee the issuer's performance — that trust is social, out-of-band.

A **transfer** moves a Promise from one holder to another. The debit holder's balance decreases; the credit holder's balance increases. The sum across all Accounts for a given Promise is always zero.

**Minting is a transfer too.** Issuing a Promise creates the first debit/credit record pair between two of the issuer's own accounts: the *issue* account goes negative, the *holding* account goes positive. There is no special mint balance logic — the same mechanism that moves value in trades creates it at mint.

---


## 1. Trust model

barter.game v1 is built on three behavioral assumptions. They are not enforced by cryptography; they are the social substrate that makes the protocol's risk posture coherent.

1. **Users already know the issuers of the Promises they hold.**
   Discovery is out of band — DM, in-person, group chat. The protocol does not search for trading partners, rate issuers, or verify delivery.

2. **Trust is socially enforced.**
   If Alice delivers and Bob ghosts, Alice yells at Bob. The protocol records the deal cryptographically; it does not arbitrate. Recourse is human, not algorithmic.

3. **Bank operators are accountable to their issuers.**
   Anyone can run a bank, but the issuers who route their Promises through it have a real relationship with the operator. An operator can erase its ledger or abort transactions — there is no cryptographic prevention — but it cannot forge a plausible alternative history alone, because every deal requires interlinked signatures from multiple independent parties.

### 1.1 v0 openness

Banks are open by default. The v1 reference posture:

- Banks allow minting **any** promise that references them.
- Banks accept new ledger records for new accounts and new promises; they only check that the promise references the bank.
- Banks accept and store any docs/signatures linked to promises that reference this bank, **from anyone** — the sender of a request need not be the doc's owner (counterparties legitimately carry each other's Account docs and relay each other's signatures).
- All calls to bank APIs are signed by the sender's key. Moderation is **key-blocking**, not gatekeeping: banks MAY refuse service to spammers and abusers based on their pubkey.

> **Extensibility:** Implementers MAY add additional trust, reputation, KYC, or audit mechanisms on top of the protocol. Such extensions MUST be backward-compatible: they must not prevent a client and bank from interacting using only the base v1 wire format.

---


## 2. Settlement model — direct approval, three waves, lead/follow

A deal executes in three waves: **ready → hold → settle**. Wave 1 (*direct approval*) is driven by the holders; waves 2 and 3 are driven by the **banks themselves** — banks self-advance as signatures arrive, and there is no client `hold` or `settle` call.

### 2.0 Three-wave execution model: ready → hold → settle

**1. Ready** — every holder whose accounts are touched by the deal must authorize their part of the deal by signing their own **Tx or Order**. Authorization is independent: Alice can authorize without waiting for Bob. A bank then validates those authorizations and issues a record-level `ready` signature on each of its own Records when it is prepared to proceed. Authorization can come from:

- A direct holder `lead` or `follow` signature on the holder's own **Tx**.
- A matching `Order` doc (bank-schema.md §5.7). When a holder is represented by an Order, the holder's bank issues `ready` on the matched Records on the holder's behalf, checking at ready time that the relevant accounts have sufficient free balance.
- A matching `Offer` doc (bank-schema.md §5.8) — a bank-issued derivation of an Order. The holder still signs the Tx that references the Offer.
- An invoice or cheque specialization of an Order or Offer (one side omitted, §5.7).

If a bank sees both a direct Tx signature and a matching Order/Offer for the same Records, either one satisfies the ready gate. For a `lead` Order/Offer, the holder signature may be omitted entirely; the bank executes on the Order/Offer alone.

A bank's records become **approved** once every Record it owns is bound to a valid authorization and carries the bank's per-record `ready`.

**2. Hold** — once all of a bank's records are `ready`, the bank locks the debit accounts among those records, issues record-level `hold` Signatures, and fans them out (§2.4). A bank holds when:

- any holder Tx touching its records is `lead`, **or**
- every holder Tx touching its records is `follow` AND every predecessor bank whose output those holders depend on has already issued `hold` signatures on its own records.

Holds are per-account and per-bank. A `-32003` conflict means some account is already locked by another in-flight deal; the bank retries on the next event. A client may call `reject` on individual records to abort them.

**3. Settle** — settlement is an ordered cascade of record-level signatures, not a single atomic flip:

- a **lead** bank settles first on its own records — but only once it has observed `hold` Signatures on the corresponding records from **every other bank in the deal**, so the whole graph is locked before anyone moves;
- a **follow** bank settles on its own records only after it has verified record-level `settle` Signatures from **every one of its predecessors**, and cites their hashes in its own settle's `Signature.seen` (base.md §5.6).

Settling means: apply the deltas of every owned record, release the holds, issue `settle` signatures, fan out.

> **Implementation note:** The v1 reference implementation calls `create_records` on each bank, then each holder builds their own Tx and calls `submit_tx` on every bank that owns records touching their accounts. `submit_tx` issues per-record `ready` (or `reject`) signatures. Once all its records are approved, the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied.

### 2.1 Authorization sources

A bank advances a record only when it has valid authorization — a holder-signed Tx or matching Order/Offer — for every **Record** (credit or debit) touching a holder's account. The authorization sources, in precedence order:

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

The lead set is whichever holders must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead settles first on its own records; the follower settles on its own records once the client relays the lead's record-level `settle` signatures.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A's bank, B's bank}`. After they settle, C's bank settles `C → D`, then D's bank settles `D → A` and `D → B`, closing both cycles.

If any downstream bank refuses to apply (compromise, malice, downtime), every record that already settled stays settled: their promises moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank sees only its own records

**No bank ever sees the whole deal.** A bank sees only the transfers of the promises *it issues* — "this much of my promise leaves holder X; this much arrives at holder Y" — and nothing about the other records.

This falls straight out of the issuer-authority rule (§5.3, §9): a transfer of promise `P` lives entirely at `P`'s issuer bank (debit and credit are both `P`-accounts there), and every record carries `pubkey =` `P`'s issuer bank. A bank only ever locks, applies, and signs records whose `pubkey` is its own.

The **initiating client** is the one party that legitimately knows the whole deal — it designed it — so it builds the graph and hands each bank only that bank's slice:

- **Bodies it gets:** only the credit/debit records whose promise this bank issues.
- **Hashes it gets:** the record hashes in each holder Tx presented to it. These are opaque identifiers. A bank needs them to verify that its own records are included in each Tx; it cannot infer another record's amount, account, holder, or promise from a record hash alone.
- **Routing it gets:** for the settle cascade, the pubkeys of its immediate **predecessor banks** (so it can verify their record-level `settle` signatures, §5.6). It learns *that* a peer bank participates, not *what* that peer transfers.

> **Invariant:** This visibility boundary is load-bearing. Any implementation that lets a bank see another bank's record bodies violates the protocol.

### 2.4 Signature fan-out — Subscriptions, push, and relay

Banks advance on **signatures**, wherever they come from. The delivery topology is the initiator's choice, expressed as **Subscription docs** (bank-schema.md §5.9) sent to the banks:

- **Bank-to-bank push** (the reference default): the initiator cross-subscribes the participating banks to each other's record signatures. When a bank creates a Signature matching a watched hash, it POSTs a bank-signed `notify_signatures` envelope to the subscription's URL, fire-and-forget.
- **Client relay** (the floor): signatures carry their own authority — signer pubkey plus an ed25519 signature over the doc — so *anyone* may deliver them. A client can read one bank's signatures (`get_record_signatures`) and hand them to another (`notify_signatures`). A lost push is recovered by relay; the system needs no reliable delivery.

Every received-and-verified signature re-evaluates the bank's advance engine for the records it touches. Banks never *depend* on calling each other; push is an optimization over relay.

---


## 7. Bank API

The bank API is **doc-oriented and signature-driven**. Clients present signed documents and document-creation requests; banks store the documents they are shown, mint bank-owned identifiers (record ULIDs and `pair` values), issue their own signatures, and fan out those signatures to subscribers.

The API surface below is intentionally small. Wave 1 (ready) is driven by holder calls to `submit_tx`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied, either because a new signature arrived via push/relay or because a client re-called `submit_tx` or `notify_signatures`.

### 7.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `mint(promise, debit_account, credit_account, amount)` | issuer → issuer bank | Validate that `promise` references this bank, that both Accounts belong to the issuer, reference the promise, and use distinct Pocket hashes, and that `integer`/`limit` are respected. Store the Account docs, create the first debit/credit record pair for the requested `amount`, apply the balance deltas, and **settle it immediately** — single signer, single bank, zero counterparty risk. Issue record-level `settle` signatures; no `ready` or `hold` step is needed. |
| `submit_account(account)` | holder → issuer bank | Store an Account doc. There is no separate "open account" operation; this is it. Pocket bodies stay on the holder's machine.
| `submit_order(order, accounts[], publish_offer?)` | holder → each bank that hosts one of the referenced accounts | Store the Order and the referenced Accounts this bank can verify. If `publish_offer` is true, derive and store an Offer, and make it discoverable. Return the Order hash and, if published, the Offer hash and bank signature. |
| `submit_address(address)` | any → bank | Store or update an Address doc for the pubkey it describes, replacing any older Address by ULID. |

### 7.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records(requests, docs?, record_subscriptions?)` | client → each bank | Intake `docs`; validate each request; mint the debit/credit pairs with mandatory `pair`; attach optional `record_subscriptions` for fan-out; return the record bodies. Records are created as `draft` records; the bank copies them into active storage when they are signed. |

A `request` is either:

- `{ type: "transfer", promise_hash, amount, debit_account_hash, credit_account_hash }` — explicit transfer between two known accounts.
- `{ type: "offer_match", offer_hash, amount, account_hash }` — match against a published Offer. The bank resolves the underlying Order, validates that `account_hash` is a valid counterparty account for the requested amount and side, and creates the paired records using the Order holder's account (hidden from the matchmaker) and the provided counterparty account.

The bank validates that all accounts exist, reference the correct Promise, and satisfy the Offer terms (rate, min/max, limits) before minting records.

### 7.3 Authorization

| Method | Caller | Side effect |
|---|---|---|
| `submit_tx(tx, holder_signature?, docs?)` | any relayer → each bank owning records in `tx.records` | Verify `holder_signature` is a valid `lead`/`follow` by `tx.pubkey` over the Tx hash (or that a matching `lead` Order/Offer authorizes the Tx). Every owned record must sit on an account owned by `tx.pubkey`, and not be bound to a different Tx. Persist Tx + signature; bind records; issue per-record `ready`/`reject`. The bank then self-advances (§2.1–2.2). |


### 7.4 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `subscribe(subscription)` | creator → bank | Validate (§5.9; `subscription.pubkey` = sender); store the doc and its watch keys. |
| `notify_signatures(signatures)` | peer bank or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |

### 7.5 Read

| Method | Caller | Side effect |
|---|---|---|
| `get_record_signatures(record_hash)` | any → bank | Return the record body and every signature anchored to this record hash. Used by follow parties verifying a deal, by watchers, and by relaying clients. |
| `get_promise(promise_hash)` | any → bank | Return the Promise doc body. |
| `get_account_balance(account_hash)` | holder → issuer bank | Return current and pending balance. |
| `list_accounts()` | holder → bank | Return all accounts owned by the sender at this bank, with Promise bodies. |
| `list_offers(promise_hash, intention)` | any → bank | Return Offers for the given Promise and intention (`sell` or `buy`). |
| `get_invoice(hash)` / `get_cheque(hash)` | any → bank | Return the Order or Offer at `hash` if it has the invoice (`debit` omitted) or cheque (`credit` omitted) specialization. |
| `list_promises(filter)` | any → bank | Return Promises the bank chooses to expose (e.g., public, discoverable, or all known). Exact filters are bank policy; the method shape is protocol. |

### 7.6 Address directory (REST)

The Address directory uses plain HTTP endpoints rather than the JSON-RPC envelope:

- `GET /address/<pubkey>` — return the Address doc for the pubkey, or `404`.
- `POST /address` — body is a signed Address doc, signed by the pubkey it describes; store it if its ULID is newer than any existing Address for that pubkey.

### 7.7 Orchestration with the doc-oriented API

The initiating client builds the deal as a set of requests (explicit transfers and/or `offer_match`es), creates records at each participating bank, and lets each holder build and sign their own Tx.

1. **create_records** on every participating bank with its own requests, any Account doc bodies the requests need, and optional `record_subscriptions`.
2. **Partition per holder**: each transfer's debit record hash goes to the giver's Tx, the credit record hash to the receiver's Tx. Build one unsigned Tx per holder. Matchmakers building against `lead` Offers build their own Txs too.
3. **subscribe**: cross-subscribe the participating banks to each other's record signatures (or pick another topology — §2.4).
4. **submit_tx** the initiator's own Tx, signed `lead`, to every bank owning its records.
5. Hand every other holder their unsigned Tx (plus the record bodies and bank URLs — e.g. a deal token, §11). Each verifies against the banks (`get_record_signatures`), signs `follow`, and submits. Matchmakers submit Txs against `lead` Offers without holder signatures.
6. **The banks do the rest.** Each bank's advance engine issues `hold` once all its records are approved, then `settle` once preconditions are met. Watch with `get_record_signatures`; if a push was lost, relay signatures by hand (`get_record_signatures` → `notify_signatures`).

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Tx binding, per-record ready, hold preconditions, settle proofs — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are the protocol. The exact HTTP client library, retry policy, timeout values, and how the client stores the deal graph are implementation details.

---


## 8. State machine (per-record, per-bank)

Each bank runs its own state machine over each record it owns. Wave 1 transitions happen on client calls; from `approved` onward the bank advances **itself**, re-evaluating on every event (a `submit_tx` completing approval, a verified signature arriving via `notify_signatures`).

```
   per-record state (per bank)

   created ── create_records ──▶ all records minted

   submit_tx (by each holder → bank, this bank's records only)
        │
        ▼
   ┌──────────┐
   │ approved │  every owned Record has a valid Tx bound and is `ready`
   └────┬─────┘   (if `lead` or no predecessors, advance engine runs immediately)
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

The client is no longer required to call `submit_tx` in topological order; it only needs every holder to authorize every bank's records. Once all Txs for a bank's records are in, the bank's advance engine takes over, locking when safe, settling when safe, and emitting signatures. The client **does** need to ensure every bank eventually receives the signatures its predecessors emit; fan-out subscriptions do this automatically, and `get_record_signatures` + `notify_signatures` is the recovery path.

> **Invariant:** These states, their transitions, and their preconditions are the protocol. The storage representation and the event loop that drives self-advancement are implementation details — but a bank MUST NOT settle without its lead/follow precondition met, and MUST NOT apply a record's delta twice.

---


## 9. Concurrency

### 9.1 Double-spend prevention

When the advance engine attempts to acquire a hold on a debit account that is already locked by another deal, that hold attempt returns `-32003` for that record. The affected bank fans out the conflict signature; the coordinator (or any participant) may call `reject` on individual records to release holds and abort. Holds span the full participant set, but each per-account lock is independent and bank-local.

The approve-time balance check (§2.0) is computed net of active holds, so a deal cannot be approved against balance that another in-flight deal has locked.

> **Invariant:** At most one active hold per account MUST be enforced. How (database unique index, mutex, optimistic locking) is an implementation detail.

### 9.2 Mutual-credit balance semantics

- **Issuers go negative only through minting.** When an issuer mints a Promise, the bank creates the issuer's negative-balance row as part of `mint`. This is the only protocol path that creates a negative balance. The network owes the negative-balance side nothing; the holder owes the network nothing. Each side is accountable for their own ledger position.
- **No negative balance on holder-authorized transfers.** A transfer Tx authorized by a holder signature or by a holder Order/Offer MUST NOT drive the debit account negative. The bank rejects any Record that would overdraw the account. The `Promise.limit` field is honored if set; otherwise issuance is unbounded.
- **Sum invariant**: across all accounts for a given Promise, balances always sum to zero (or the agreed limit). The bank enforces this on every `settle`.

> **Invariant:** The sum invariant is the load-bearing correctness guarantee of the ledger. Every implementation MUST preserve it on every settle.

---


## 10. Bank discovery + pubkey pinning

### 10.1 Discovery

A bank's **canonical URL** is the base path clients use for that bank. Different banks MAY live at different paths on the same domain — for example `https://example.com/banks/alice` and `https://example.com/banks/bob`. The bank exposes its identity document at:

```
GET <bank-url>/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use. It MUST be a prefix of the URL from which `barter-bank.json` was fetched.

Banks MAY maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from, sourced from discovery documents and from explicitly presented **Address** docs (base.md §5.11). Under the client-orchestrated trade path (§2, §3) banks do not call each other, so peer caching is vestigial on the hot path in v1 — kept for discovery and future bank-to-bank features.

### 10.2 Pubkey pinning (security)

The discovery document is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see §11).
- `barter-bank.json` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

> **Invariant:** The `barter-bank.json` format and the pinning semantics are protocol. How the client stores its config is an implementation detail.

### 10.3 Address directory API

In addition to `barter-bank.json`, banks expose a public Address directory under their canonical URL:

- `GET <bank-url>/address/<pubkey>` — return the Address doc for the pubkey, or `404` if none is found.
- `POST <bank-url>/address` — create or update the Address doc for the pubkey. The bank stores the Address only if it is signed by the pubkey it describes and its ULID is newer than any existing Address for that pubkey.

This allows a bank to announce URL changes in a self-sovereign way: any party can present a newer signed Address to any bank directory, and the directory replaces the old entry.

---


## 11. Invite strings and deep links

Both OOB handoffs are self-validating signed strings: the receiver verifies the signature before any network call, and tampering invalidates it.

### 11.1 Invite strings

The inviter's offer:

```
barter://<inviter-pubkey>@<inviter-bank-url>
  ?give=<promise-hash>:<amount>:<account-hash>
  &get=<promise-hash>:<amount>:<account-hash>
  [&accs=<base64url(JSON Account bodies)>]
  &exp=<unix-seconds>&sig=<inviter-sig>
```

- `give`: what the inviter offers — promise, amount, and the inviter's **funded account** it will be debited from.
- `get`: what the inviter wants — promise, amount, and the inviter's **receiving account** (authored locally; accounts are implicit).
- `accs`: the bodies of the inviter's Account docs referenced by the records, so the initiator can present them to the banks.
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by the inviter's pubkey.

### 11.2 Deal tokens

Users share these as short deep links, typically rendered as QR codes. When another user scans the link with a smartphone camera, it opens a bank webapp that suggests creating a new key or logging into an existing app. Inside the app the user adds the promise, address, or issuer to their personal catalog. The exact UX is implementation-specific; the link format and its self-validating property are protocol.

> **Invariant:** The invite string format, its fields, and its self-validating property are protocol. How the invite is conveyed (QR code, NFC, deep link, copy-paste) is an implementation detail.

---


## 12. Protocol design decisions, locked

| Decision | Resolution | Invariant? |
|---|---|---|
| Risk model | Lead/follow; no protocol-level rollback | **Yes** |
| Trust model | Counterparties already know each other; discovery OOB | **Yes** |
| Coordinator pattern | **Client-orchestrated**: the proposing user calls each bank with its own slice and relays signatures; banks never call each other on the trade path | **Yes** |
| Visibility | Each bank sees only the records of the promises it issues + the holder Tx hash lists + its predecessor bank pubkeys; no bank sees the full deal | **Yes** |
| Issuer authority | Issuer is sole source of truth for its Promise's balances | **Yes** |
| Concurrent holds | Rejected `-32003`; first-write-wins on per-Account lock | **Yes** |
| Key recovery | Out of scope (lose key → lose account) | **Yes** |
| Key rotation | Out of scope; redeploy with new secret if compromised | **Yes** |
| Canonicalization | RFC 8785 / JCS; cross-runtime golden vectors | **Yes** |
| Account creation | Accounts are opened by presenting an unsigned Account doc to the issuing bank; there is no separate protocol operation | **Yes** |
| Promise fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 | **Yes** |
| Tx cardinality | Open: `K ≥ 1` transfer pairs across 1..N banks; bilateral (`K=2`) is the simplest case | **Yes** |
| Tx ownership | **One Tx per participating holder**, containing only records that touch that holder's accounts | **Yes** |
| Holder authorization | Holders sign Promise, Order, Tx, and Address docs; banks sign Record and Offer docs | **Yes** |
| Balance floor | Holder-authorized transfers cannot overdraw the debit account; negative balances are created only by issuer minting | **Yes** |
| Offers | Banks MAY derive and publish Offer docs from Orders; Offers hide holder identity and account hashes | **Yes** |

---


## 13. What the protocol does NOT do

These are out of scope for v1. An implementation MAY add them, but they are not part of the barter.game v1 contract:

- **No web UI.** The protocol is transport-agnostic; a web UI is a client-layer concern.
- **No protocol-level rollback.** If a follow bank goes rogue after the lead settles, the lead is out. Recourse is social.
- **No guaranteed delivery.** Fan-out is fire-and-forget; client relay is the recovery path. There is no message queue in the protocol.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Promises.** Issued Promises are fungible.
- **No automated settle-cascade retry.** The advance engine re-evaluates whenever a new signature arrives, but if a follower bank goes permanently offline after the lead settles, the lead remains settled — the lead/follow risk (§2), resolved socially. The protocol provides only per-record `reject` for pre-settled aborts.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No global bank discovery directory.** `barter-bank.json`, Address docs, and direct URL+pubkey pinning are the v1 baseline; a global federated directory is a v1.5+ extension.

---


## 14. Standard vs custom API

The open bank API that ensures interoperability and cross-bank transactions is standardized in this document: document schemas, JSON-RPC envelope, method semantics, invite strings, and discovery formats.

Banks MAY also expose custom API endpoints and UI beyond the standard surface. For example, a bank may choose its own KYC flow, fee model, admin tooling, or web dashboard. Such customizations MUST NOT alter the standard document schemas or the semantics of the methods defined in §7. Different banks may implement the custom layer differently; clients that speak only the standard protocol can still trade across them.

> **Invariant:** Anything required for two independent implementations to interoperate belongs in this protocol document. Anything that is operator-specific or UX-specific belongs in a custom or implementation layer.

---


