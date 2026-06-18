# barter.game protocol — Bank RPC API

This file defines the bank's public interface:

- JSON-RPC methods for minting, record creation, authorization, signature fan-out, and reads
- REST address-directory endpoints
- Orchestration recipe
- Bank discovery

For document schemas and ledger semantics, see [`bank-schema.md`](./bank-schema.md). For the envelope, signatures, and base types, see [`base.md`](./base.md). For the trust and settlement narrative, see [`README.md`](./README.md).

---

## 1. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with the envelope shape defined in [`base.md`](./base.md): `jsonrpc`, `id`, `method`, `params`, `pubkey`, `to`, `sig`. Replay protection and error codes are also defined there.

---

## 2. Bank API

The bank API is **doc-oriented and signature-driven**. Clients present signed documents and document-creation requests; banks store the documents they are shown, mint bank-owned identifiers (record ULIDs and `pair` values), issue their own signatures, and fan out those signatures to subscribers.

The API surface below is intentionally small. Wave 1 (ready) is driven by holder calls to `submit_tx`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied, either because a new signature arrived via push/relay or because a client re-called `submit_tx` or `notify_signatures`.

### 2.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `mint(voucher, debit_account, credit_account, amount)` | issuer → issuer bank | Validate that `voucher` references this bank, that both Accounts belong to the issuer, reference the voucher, and use distinct Account hashes, and that `integer`/`limit` are respected. Store the Account docs, create the first debit/credit record pair for the requested `amount`, apply the balance deltas, and **settle it immediately** — single signer, single bank, zero counterparty risk. Issue record-level `settle` signatures; no `ready` or `hold` step is needed. |
| `submit_account(account)` | holder → issuer bank | Store an Account doc. There is no separate "open account" operation; this is it. Account bodies stay on the holder's machine. |
| `submit_order(order, accounts[], publish_offer?)` | holder → each bank that hosts one of the referenced accounts | Store the Order and the referenced Accounts this bank can verify. If `publish_offer` is true, derive and store an Offer, and make it discoverable. Return the Order hash and, if published, the Offer hash and bank signature. |
| `submit_address(address)` | any → bank | Store or update an Address doc for the pubkey it describes, replacing any older Address by ULID. |

### 2.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records(requests, docs?, record_subscriptions?)` | client → each bank | Intake `docs`; validate each request; mint the debit/credit pairs with mandatory `pair`; attach optional `record_subscriptions` for fan-out; return the record bodies. Records are created as `draft` records; the bank copies them into active storage when they are signed. |

A `request` is either:

- `{ type: "transfer", voucher_hash, amount, debit_account_hash, credit_account_hash }` — explicit transfer between two known accounts.
- `{ type: "offer_match", offer_hash, amount, account_hash }` — match against a published Offer. The bank resolves the underlying Order, validates that `account_hash` is a valid counterparty account for the requested amount and side, and creates the paired records using the Order holder's account (hidden from the matchmaker) and the provided counterparty account.

The bank validates that all accounts exist, reference the correct Voucher, and satisfy the Offer terms (rate, min/max, limits) before minting records.

### 2.3 Authorization

| Method | Caller | Side effect |
|---|---|---|
| `submit_tx(tx, holder_signature?, docs?)` | any relayer → each bank owning records in `tx.records` | Verify `holder_signature` is a valid `lead`/`follow` by `tx.pubkey` over the Tx hash (or that a matching `lead` Order/Offer authorizes the Tx). Every owned record must sit on an account owned by `tx.pubkey`, and not be bound to a different Tx. Persist Tx + signature; bind records; issue per-record `ready`/`reject`. The bank then self-advances (see `bank-schema.md` §2). |

### 2.4 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `subscribe(subscription)` | creator → bank | Validate (see `bank-schema.md` §1.8; `subscription.pubkey` = sender); store the doc and its watch keys. |
| `notify_signatures(signatures)` | peer bank or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |

### 2.5 Read

| Method | Caller | Side effect |
|---|---|---|
| `get_record_signatures(record_hash)` | any → bank | Return the record body and every signature anchored to this record hash. Used by follow parties verifying a deal, by watchers, and by relaying clients. |
| `get_voucher(voucher_hash)` | any → bank | Return the Voucher doc body. |
| `get_account_balance(account_hash)` | holder → issuer bank | Return current and pending balance. |
| `list_accounts()` | holder → bank | Return all accounts owned by the sender at this bank, with Voucher bodies. |
| `list_offers(voucher_hash, intention)` | any → bank | Return Offers for the given Voucher and intention (`sell` or `buy`). |
| `get_invoice(hash)` / `get_cheque(hash)` | any → bank | Return the Order or Offer at `hash` if it has the invoice (`debit` omitted) or cheque (`credit` omitted) specialization. |
| `list_vouchers(filter)` | any → bank | Return Vouchers the bank chooses to expose (e.g., public, discoverable, or all known). Exact filters are bank policy; the method shape is protocol. |

### 2.6 Address directory (REST)

The Address directory uses plain HTTP endpoints rather than the JSON-RPC envelope:

- `GET /address/<pubkey>` — return the Address doc for the pubkey, or `404`.
- `POST /address` — body is a signed Address doc, signed by the pubkey it describes; store it if its ULID is newer than any existing Address for that pubkey.

These are the same endpoints referenced in [`base.md`](./base.md) §3.2.

---

## 3. Bank discovery

A bank exposes its identity document at:

```
GET <bank-url>/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use. It MUST be a prefix of the URL from which `barter-bank.json` was fetched. Discovery and pubkey pinning semantics are defined in [`base.md`](./base.md) §5.

---

## 4. Orchestration with the doc-oriented API

The initiating client builds the deal as a set of requests (explicit transfers and/or `offer_match`es), creates records at each participating bank, and lets each holder build and sign their own Tx.

1. **create_records** on every participating bank with its own requests, any Account doc bodies the requests need, and optional `record_subscriptions`.
2. **Partition per holder**: each transfer's debit record hash goes to the giver's Tx, the credit record hash to the receiver's Tx. Build one unsigned Tx per holder. Matchmakers building against `lead` Offers build their own Txs too.
3. **subscribe**: cross-subscribe the participating banks to each other's record signatures (or pick another topology — see `README.md` §2.4).
4. **submit_tx** the initiator's own Tx, signed `lead`, to every bank owning its records.
5. Hand every other holder their unsigned Tx (plus the record bodies and bank URLs — e.g. a deal token, see `README.md` §3). Each verifies against the banks (`get_record_signatures`), signs `follow`, and submits. Matchmakers submit Txs against `lead` Offers without holder signatures.
6. **The banks do the rest.** Each bank's advance engine issues `hold` once all its records are approved, then `settle` once preconditions are met. Watch with `get_record_signatures`; if a push was lost, relay signatures by hand (`get_record_signatures` → `notify_signatures`).

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Tx binding, per-record ready, hold preconditions, settle proofs — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are protocol. The exact HTTP client library, retry policy, timeout values, and how the client stores the deal graph are implementation details.
