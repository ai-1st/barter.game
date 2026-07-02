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

The API surface below is intentionally small. Wave 1 (ready) is driven by coordinator calls to `create_records` followed by holder `submit_docs` (for Orders/Accounts) and coordinator `submit_mandate`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied. Banks learn each other's URLs from the Address registry and call each other directly; subscriptions are optional and not required for settlement.

### 2.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `submit_docs(docs, publish_offers?)` | any → bank | Validate and store each BaseDoc in `docs`. The bank routes by `type`: Vouchers must have `pubkey == bank`; Accounts must reference a known Voucher and be signed by the holder; Orders must reference known Accounts signed by the same holder and have a valid, positive `rate`; Addresses update the address directory if newer by ULID. Optionally derive and publish discovery Offers for any Order hashes listed in `publish_offers`. Return the hashes of stored docs and any derived Offers. |
| `submit_mandate(mandate, records)` | coordinator → each participating bank | Validate and execute one [`Mandate`](bank-schema.md#16-mandate) as a unit of work. The coordinator passes the signed `mandate` **together with the `records` bodies** it lists. The bank verifies the coordinator signature, that `mandate.bank` is this bank, that each listed record is one it created for `mandate.deal_id` with `details.coordinator == mandate.pubkey` and `Record.order == mandate.order`, resolves `mandate.order` to a stored Order, validates that Order's conditions against the records (rate via the `counter_amount` from `create_records`, plus `min`/`max` and limits), and rejects a duplicate Mandate for the same `(deal_id, order)`. Once validated, the bank advances those records out of `created`. |

### 2.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records({ giver, receiver, amount, counter_amount, deal_id })` | coordinator → each bank | Mint the single debit/credit record pair that moves **this bank's voucher** from the `giver` to the `receiver`; seal `deal_id` and the coordinator pubkey into each `RecordDetails`; return the record bodies. Records are stored as `created` and stay there until a matching [`Mandate`](bank-schema.md#16-mandate) and the authorizing Orders arrive. |

```ts
create_records(params: {
  giver:          Base58SHA256;  // Order hash — the holder GIVING this bank's voucher (its `debit` side is here)
  receiver:       Base58SHA256;  // Order hash — the holder RECEIVING this bank's voucher (its `credit` side is here)
  amount:         number;        // units of THIS bank's voucher moved giver → receiver
  counter_amount: number;        // units of the counterparty voucher (the giver's `credit` / receiver's `debit`), for the rate check
  deal_id:        ULID;
})
```

**Order hashes only.** `giver` and `receiver` are hashes of holder-signed **Order** docs — never Offers. An Order has a single canonical hash and the holder submits the same Order to every bank its sides touch, so the same hash resolves identically at every participating bank (a coordinator reads the Order hash from a discovery Offer's `order` field). Both Orders must already be stored at this bank (via `submit_docs`).

This bank issues exactly one voucher `V`. The call mints **one** transfer of `V`:

- a **debit** record on `giver`'s `debit.account` (giver's `debit.voucher` is `V`), and
- a **credit** record on `receiver`'s `credit.account` (receiver's `credit.voucher` is `V`),

both for `amount`, paired by a fresh `pair` ULID, tagged with `deal_id`, and sealed with `details.coordinator = <sender pubkey>`.

The bank verifies:

- `giver` and `receiver` resolve to valid, signed, stored Orders.
- `giver.debit.voucher == receiver.credit.voucher == V` (this bank's voucher); both `bank` fields are this bank.
- `amount` is within `giver.debit.min/max` and `receiver.credit.min/max`.
- **Rate** (two-sided Orders): `amount / counter_amount <= giver.rate` and `counter_amount / amount <= receiver.rate`. When the other side is also at this bank, `counter_amount` is verified against that side's records; when it is at another bank, `counter_amount` is the coordinator's assertion and the rate is enforced softly (the holder's `min`/`max`, checked by the bank that owns each side, is the hard bound — see [`bank-schema.md` §1.4](bank-schema.md)).
- The resulting records would not violate `Voucher.limit` or any Order cumulative/account limit.

The bank rejects the request if any check fails.

**Idempotency.** `create_records` MUST be idempotent on `(deal_id, giver, receiver)`: a repeated call with the same terms returns the originally minted record pair; a repeated call with **different** `amount`/`counter_amount` for the same key MUST be rejected (`-32000`), never mint a second pair. Distinct pairs within one deal (merge/branch, spread legs) differ in `giver` or `receiver` and are unaffected.

**Same-bank deals.** When this bank issues **both** vouchers in the swap, the coordinator calls `create_records` **twice** — once per voucher — with `giver` and `receiver` swapped:

```ts
// Voucher X (Alice gives, Bob gets):  amount = X units, counter_amount = Y units
create_records({ giver: Aorder, receiver: Border, amount: 100, counter_amount: 90,  deal_id })
// Voucher Y (Bob gives, Alice gets):  amount = Y units, counter_amount = X units
create_records({ giver: Border, receiver: Aorder, amount: 90,  counter_amount: 100, deal_id })
```

Across two banks, the coordinator makes one call to each bank, with `giver`/`receiver` chosen so each call's `giver.debit.voucher` is that bank's voucher.

> **No other caller may create records.** There is no `mint`; issuers begin trading by placing Orders that debit the issuer account.

### 2.3 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `subscribe(subscription)` | creator → bank | Optional. Validate (see `bank-schema.md` §1.7; `subscription.pubkey` = sender); store the doc and its watch keys. Useful for clients/watchers that want push delivery, but banks do not rely on subscriptions to settle. |
| `notify_signatures(signatures)` | peer bank (direct) or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |

### 2.4 Read

| Method | Caller | Side effect |
|---|---|---|
| `get_record_signatures(record_hash)` | any → bank | Return the record body and every signature anchored to this record hash. Used by follow parties verifying a deal, by watchers, and by relaying clients. |
| `get_address(pubkey)` | any → bank | Return the newest signed `Address` doc for the given pubkey, or an error if none is known. Equivalent to `GET /address/<pubkey>`. |
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

The coordinator builds the deal by discovering compatible Orders (via their discovery Offers) and asking each bank to create the records that connect them.

1. **Holders publish intent.** Each holder calls `submit_docs` with their Voucher, Account, and Order docs, optionally requesting discovery-Offer publication (`publish_offers: [<order-hash>]`). The same Order is submitted to every bank that issues a Voucher on either side of it.
2. **Coordinator discovers Orders.** The coordinator scans `list_offers` (or an off-band stream) for two Offers on opposite sides of the same Voucher that form a mutually acceptable trade, and reads each Offer's `order` field to obtain the two holder **Order hashes** (`giver`, `receiver`).
3. **Share Address docs.** Before banks can call each other directly, each bank must have a signed `Address` doc for every peer bank. The coordinator fetches each bank's current Address (`get_address`) and submits it to the other participating banks via `submit_docs`. Banks also accept newer Address docs at any time.
4. **create_records** on every participating bank, referencing the two Order hashes plus `amount` / `counter_amount` and a shared `deal_id`. Each bank mints the debit/credit record pair for the voucher it issues; for a same-bank swap the coordinator calls twice with `giver`/`receiver` swapped (see §2.2).
5. **submit_mandate.** For each (Order, bank) the coordinator builds a `Mandate` naming that Order and listing the bank's records satisfying it, signs it, and sends it **with the record bodies** to the bank.
6. **Banks advance.** Once a bank has both (a) a `Mandate` for an Order and (b) that Order bound to its records (already stored via `submit_docs`), its advance engine issues `ready`, then `hold`, then `settle` automatically as preconditions are met. Banks discover each other via the `bank` fields in the Orders and use the Address registry to call each other directly; `notify_signatures` is the canonical bank-to-bank delivery path.
7. **Relay fallback.** If direct bank-to-bank delivery fails, any party can relay signatures by hand (`get_record_signatures` → `notify_signatures`). Subscriptions are optional and only useful for watchers or clients that want push delivery.

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Order resolution, per-record ready, hold preconditions, settle proofs, Mandate clearance — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are protocol. The exact HTTP client library, retry policy, timeout values, and how the coordinator discovers Orders are implementation details.
