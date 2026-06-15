# barter.game protocol — bank RPC (v1)

> **Bank RPC contract.** This document defines the bank API methods, state machine, concurrency rules, discovery, and invite strings. For the trust model and settlement model, see `README.md`. For foundational primitives, see `base.md`. For banking document types, see `bank-schema.md`.

> **This document is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in this file. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in this document is an implementation detail — you may change it.
>
> If you are building your own bank or client, read `README.md` and `base.md` first, then see `IMPLEMENTATION.md` for how the reference team chose to build it. `MASTER-INPUT.md` is the source-of-truth design narrative from the product owner; `scenarios/*.md` are step-by-step interaction traces.

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
| `submit_tx(tx, holder_signature?, docs?)` | any relayer → each bank owning records in `tx.records` | Verify `holder_signature` is a valid `lead`/`follow` by `tx.pubkey` over the Tx hash (or that a matching `lead` Order/Offer authorizes the Tx). Every owned record must sit on an account owned by `tx.pubkey`, and not be bound to a different Tx. Persist Tx + signature; bind records; issue per-record `ready`/`reject`. The bank then self-advances (README.md §2.1–2.2). |


### 7.4 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `subscribe(subscription)` | creator → bank | Validate (`bank-schema.md` §5.9; `subscription.pubkey` = sender); store the doc and its watch keys. |
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
3. **subscribe**: cross-subscribe the participating banks to each other's record signatures (or pick another topology — `README.md` §2.4).
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

The approve-time balance check (README.md §2.0) is computed net of active holds, so a deal cannot be approved against balance that another in-flight deal has locked.

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

Banks MAY maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from, sourced from discovery documents and from explicitly presented **Address** docs (base.md §5.11). Under the client-orchestrated trade path (README.md §2, §3) banks do not call each other, so peer caching is vestigial on the hot path in v1 — kept for discovery and future bank-to-bank features.

### 10.2 Pubkey pinning (security)

The discovery document is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see §11).
- `barter-bank.json` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model (README.md §1) the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

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
- **No automated settle-cascade retry.** The advance engine re-evaluates whenever a new signature arrives, but if a follower bank goes permanently offline after the lead settles, the lead remains settled — the lead/follow risk (README.md §2), resolved socially. The protocol provides only per-record `reject` for pre-settled aborts.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No global bank discovery directory.** `barter-bank.json`, Address docs, and direct URL+pubkey pinning are the v1 baseline; a global federated directory is a v1.5+ extension.

---


## 14. Standard vs custom API

The open bank API that ensures interoperability and cross-bank transactions is standardized in this document: document schemas, JSON-RPC envelope, method semantics, invite strings, and discovery formats.

Banks MAY also expose custom API endpoints and UI beyond the standard surface. For example, a bank may choose its own KYC flow, fee model, admin tooling, or web dashboard. Such customizations MUST NOT alter the standard document schemas or the semantics of the methods defined in §7. Different banks may implement the custom layer differently; clients that speak only the standard protocol can still trade across them.

> **Invariant:** Anything required for two independent implementations to interoperate belongs in this protocol document. Anything that is operator-specific or UX-specific belongs in a custom or implementation layer.

---


