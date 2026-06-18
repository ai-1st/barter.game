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

The API surface below is intentionally small. Wave 1 (ready) is driven by matchmaker calls to `create_records` followed by holder `submit_docs` (for Orders/Accounts) and matchmaker `submit_confirm`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied, either because a new signature arrived via push/relay or because a client re-called `submit_docs`, `submit_confirm`, or `notify_signatures`.

### 2.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `submit_docs(docs, publish_offers?)` | any → bank | Validate and store each BaseDoc in `docs`. The bank routes by `type`: Vouchers must have `pubkey == bank`; Accounts must reference a known Voucher and be signed by the holder; Orders must reference known Accounts signed by the same holder and have a valid, positive `rate`; Addresses update the address directory if newer by ULID. Optionally derive and publish Offers for any Order hashes listed in `publish_offers`. Return the hashes of stored docs and any derived Offers. |
| `submit_confirm(confirm)` | matchmaker → each participating bank | Verify the matchmaker's signature, that `confirm.bank` is this bank, and that every Record this bank created for `confirm.deal_id` is listed. Once verified, the bank may advance those records out of `created` as soon as valid Orders are bound. |

### 2.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records({ offer1, offer2, deal_id, record_subscriptions? })` | matchmaker → each bank | Resolve the two Offers; mint the single debit/credit record pair this bank is responsible for; tag it with `deal_id`; attach optional `record_subscriptions` for fan-out; return the record bodies. Records are created as `created` records and stay there until `submit_confirm` and matching Orders arrive. |

```ts
create_records(params: {
  offer1: { hash, debit_amount, credit_amount };
  offer2: { hash, debit_amount, credit_amount };
  deal_id: ULID;
  record_subscriptions?: RecordSubscription[];
})
```

The matchmaker passes the same `offer1` and `offer2` to every participating bank. Each bank extracts the two amounts that apply to the Voucher it issues and creates one debit/credit record pair for that Voucher. A bank MAY receive multiple `create_records` calls for the same `deal_id`; each call mints an independent record pair. The matchmaker's `Confirm` for that bank must list every record created for the deal.

Parameter mapping for a swap where Alice gives Voucher X and receives Voucher Y, while Bob gives Voucher Y and receives Voucher X:

```ts
offer1: {
  hash: <alice-offer-hash>,         // Alice's Offer: debit X, credit Y
  debit_amount: 100,                // amount of X Alice gives
  credit_amount: 90                 // amount of Y Alice receives
}
offer2: {
  hash: <bob-offer-hash>,           // Bob's Offer: debit Y, credit X
  debit_amount: 90,                 // amount of Y Bob gives
  credit_amount: 100                // amount of X Bob receives
}
deal_id: <deal-id>
```

- At the bank issuing **X**: use `offer1.debit_amount` and `offer2.credit_amount` to create the X record pair.
- At the bank issuing **Y**: use `offer1.credit_amount` and `offer2.debit_amount` to create the Y record pair.

The bank verifies:

- Both Offers are valid and bank-signed. At least one of them was issued by this bank; the other may be foreign.
- The local amount pair (the two amounts that apply to this bank's Voucher) are equal.
- The local amount satisfies the local Offer's `min`/`max` constraints.
- For each Offer, the ratio of the matched debit amount to the matched credit amount is `<=` the Offer's `rate` (within rounding policy).
- Both Offers resolve to stored Orders (or the bank already has the Orders).
- The resulting records would not violate `Voucher.limit` or any Order limit.

The bank rejects the request if any of these checks fail.

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

The Address directory exposes one plain HTTP endpoint for discovery:

- `GET /address/<pubkey>` — return the newest Address doc for the pubkey, or `404`.

Address docs are submitted and updated through the standard `submit_docs` JSON-RPC method. This keeps the write path uniform with Vouchers, Accounts, and Orders.

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

1. **Holders publish intent.** Each holder calls `submit_docs` with their Voucher, Account, and Order docs, optionally requesting Offer publication (`publish_offers: [<order-hash>]`). The same Order is submitted to every bank that issues a Voucher on either side of it.
2. **Matchmaker discovers Offers.** The matchmaker scans `list_offers` (or an off-band offer stream) and picks, for each bank, two Offers on opposite sides of the same Voucher that form a mutually acceptable trade.
3. **create_records** on every participating bank with the same `offer1` / `offer2` object shape and shared `deal_id`, plus optional `record_subscriptions`. Each bank extracts the amounts that apply to the Voucher it issues and mints one debit/credit record pair.
4. **submit_confirm.** The matchmaker collects the returned record bodies, builds a per-bank `Confirm` listing that bank's records, signs it, and sends it to each bank.
5. **Banks advance.** Once a bank has both (a) the `Confirm` for this deal and (b) valid Orders bound to its records (already stored via `submit_docs`), its advance engine issues `ready`, then `hold`, then `settle` automatically as preconditions are met.
6. **Watch and relay.** Follow banks subscribe to predecessor bank signatures. If a push is lost, any party can relay signatures by hand (`get_record_signatures` → `notify_signatures`).

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Offer resolution, per-record ready, hold preconditions, settle proofs, Confirm clearance — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are protocol. The exact HTTP client library, retry policy, timeout values, and how the matchmaker discovers Offers are implementation details.
