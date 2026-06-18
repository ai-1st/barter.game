# barter.game protocol — Bank RPC API

This file defines the bank's public interface:

- JSON-RPC methods for voucher/account/order submission, record creation, authorization clearance, signature fan-out, and reads
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

The API surface below is intentionally small. Wave 1 (ready) is driven by matchmaker calls to `create_records` followed by holder `submit_order` and matchmaker `submit_confirm`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied, either because a new signature arrived via push/relay or because a client re-called `submit_order`, `submit_confirm`, or `notify_signatures`.

### 2.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `submit_voucher(voucher)` | issuer → issuer bank | Store a Voucher doc. The bank validates that `voucher.pubkey == voucher.bank` (only the issuer may register a Voucher at this bank) and that the Voucher fields are valid. |
| `submit_account(account)` | holder → issuer bank | Store an Account doc. There is no separate "open account" operation; this is it. Account bodies stay on the holder's machine. |
| `submit_order(order, accounts[])` | holder → each bank that issues a Voucher referenced by the Order | Store the Order and the referenced Accounts this bank can verify. Return the Order hash. The same Order is submitted to every bank that issues a Voucher on either side of the Order. |
| `submit_confirm(confirm)` | matchmaker → each participating bank | Verify the matchmaker's signature, that `confirm.bank` is this bank, and that every Record this bank created for `confirm.deal_id` is listed. Once verified, the bank may advance those records out of `created` as soon as valid Orders are bound. |
| `submit_address(address)` | any → bank | Store or update an Address doc for the pubkey it describes, replacing any older Address by ULID. |

### 2.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records(requests, docs?, record_subscriptions?)` | matchmaker → each bank | Intake `docs`; validate each request; mint the debit/credit pairs with mandatory `pair` and `deal_id`; attach optional `record_subscriptions` for fan-out; return the record bodies. Records are created as `created` records and stay there until `submit_confirm` and matching Orders arrive. |

The only `request` type in v1 is:

```ts
{ type: "offer_pair", offer1, offer2, amount, deal_id }
```

- `offer1` and `offer2` are hashes of **Offers issued by this bank**. They MUST be on opposite sides of the same Voucher: one debits the Voucher, the other credits it. The bank resolves each Offer to its underlying Order, creates a debit record for the seller and a credit record for the buyer, and tags both with the supplied `deal_id`.
- `amount` is the amount of this bank's Voucher to transfer from the seller to the buyer. The bank verifies it satisfies both Offers' `min`/`max` constraints.
- `deal_id` is a ULID chosen by the matchmaker. All records created by all banks for the same deal share this id.

The bank rejects the request if:

- either Offer is unknown or was not issued by this bank;
- either Offer cannot be resolved to a stored Order;
- the Offers are not on opposite sides of a Voucher this bank issues;
- `amount` is outside either Offer's limits;
- the resulting records would violate the `Voucher.limit` or any Order limit.

> **No other caller may create records.** There is no `mint`; issuers begin trading by placing Orders that debit the issuer account.

### 2.3 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `subscribe(subscription)` | creator → bank | Validate (see `bank-schema.md` §1.7; `subscription.pubkey` = sender); store the doc and its watch keys. |
| `notify_signatures(signatures)` | peer bank or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |

### 2.4 Read

| Method | Caller | Side effect |
|---|---|---|
| `get_record_signatures(record_hash)` | any → bank | Return the record body and every signature anchored to this record hash. Used by follow parties verifying a deal, by watchers, and by relaying clients. |
| `get_voucher(voucher_hash)` | any → bank | Return the Voucher doc body. |
| `get_account_balance(account_hash)` | holder → issuer bank | Return current and pending balance. |
| `list_accounts()` | holder → bank | Return all accounts owned by the sender at this bank, with Voucher bodies. |
| `list_offers(voucher_hash, intention)` | any → bank | Return Offers for the given Voucher and intention (`sell` or `buy`). |
| `get_invoice(hash)` / `get_cheque(hash)` | any → bank | Return the Order or Offer at `hash` if it has the invoice (`debit` omitted) or cheque (`credit` omitted) specialization. |
| `list_vouchers(filter)` | any → bank | Return Vouchers the bank chooses to expose (e.g., public, discoverable, or all known). Exact filters are bank policy; the method shape is protocol. |

### 2.5 Address directory (REST)

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

The matchmaker builds the deal by discovering compatible Offers and asking each bank to create the records that connect them.

1. **Holders publish intent.** Each holder submits their Voucher, Account, and Order to the banks that issue the Vouchers they want to trade. Banks MAY derive and publish Offers.
2. **Matchmaker discovers Offers.** The matchmaker scans `list_offers` (or an off-band offer stream) and picks, for each bank, two Offers on opposite sides of the same Voucher that form a mutually acceptable trade.
3. **create_records** on every participating bank with an `offer_pair` request (`offer1`, `offer2`, `amount`, `deal_id`), plus any Account doc bodies the bank still needs and optional `record_subscriptions`.
4. **submit_confirm.** The matchmaker collects the returned record bodies, builds a per-bank `Confirm` listing that bank's records, signs it, and sends it to each bank.
5. **Banks advance.** Once a bank has both (a) the `Confirm` for this deal and (b) valid Orders bound to its records (either already stored or submitted via `submit_order`), its advance engine issues `ready`, then `hold`, then `settle` automatically as preconditions are met.
6. **Watch and relay.** Follow banks subscribe to predecessor bank signatures. If a push is lost, any party can relay signatures by hand (`get_record_signatures` → `notify_signatures`).

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Offer resolution, per-record ready, hold preconditions, settle proofs, Confirm clearance — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are protocol. The exact HTTP client library, retry policy, timeout values, and how the matchmaker discovers Offers are implementation details.
