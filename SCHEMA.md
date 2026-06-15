# Database schema — v1 (Reference Implementation)

> **This is an implementation detail, not a protocol invariant.** The barter.game v1 protocol ([`protocol/bank-schema.md`](./protocol/bank-schema.md) §2–§3) requires certain correctness guarantees — sum-to-zero, at most one active hold per account, atomic state transitions — but it does not mandate Deno KV, Deno Deploy, or any specific schema. You may use SQLite, LevelDB, DynamoDB, or a custom store as long as you enforce the same invariants.
>
> This document describes the key-space used by the v1 reference implementation. Treat it as a working example, not a contract.

barter.game v1 runs on **Deno KV** inside a Deno Deploy bank process. One KV database backs all banks served by that process; every key is prefixed with the bank's pubkey so multiple banks can share the same KV instance. There is no row-level security in v1 — the Deno Deploy process is the trust boundary, and direct KV access is operator-only.

The schema lives in code (`apps/bank/db.ts`). Per the v1 policy, demo banks are wiped on schema change.

---

## Conventions

- **`base58` strings** — all hashes, pubkeys, and signatures are stored as base58 strings. No binary types.
- **`bank_pubkey` key prefix** — the first element of every KV key is the bank's pubkey. Every query goes through it; missing this prefix is a bug.
- **Balances as strings** — exact arithmetic; never numbers. Ledger math is done by parsing to integer/decimal and serializing back to string.
- **ISO 8601 timestamps** — stored as strings when needed; most freshness is handled by numeric millisecond timestamps (e.g. replay window).
- **ULIDs** — Crockford base32, sortable by emission time.

---

## Key prefixes

### `docs` — content-addressed signed-doc archive

Every signed doc the bank has ever seen, keyed by its content hash. This is the bank's eternal append-only history for content-addressed docs: Promise, Account, Tx, Signature, Order, Subscription, and Address. Ledger records are NOT stored here (they live under `ledger_records`), and **Pocket bodies never reach a bank** — accounts reference pockets by opaque hash.

| Key | Value shape |
|---|---|
| `[bankPubkey, "docs", hash]` | `{ hash, bank_pubkey, type, pubkey, body }` |

- `hash` — base58(sha256(canonical(doc)))
- `type` — `promise` \| `account` \| `tx` \| `signature` \| `order` \| `subscription` \| `address`
- `pubkey` — doc.pubkey (owner / signer)
- `body` — the full signed doc

Inserts are idempotent: `insertDoc` checks for an existing value and returns if present, so receiving the same doc twice is a no-op. This makes RPC retries and signature relays safe.

Signature docs are looked up by their anchor fields (`body.record`, `body.hash`, `body.deal`) via prefix scan over `[bankPubkey, "docs"]` and filtering — the advance engine's "have I seen the predecessor's settle?" checks and `get_deal`'s signature listing both use this scan.

---

### `accounts` — per-(promise, holder) balance optimization

The issuer bank maintains a balance row per Account. This is derivable from the doc stream, but materializing it makes balance queries O(1) and makes the sum invariant trivially checkable.

Rows are created **lazily** — accounts are implicit; the row appears (at balance `"0"`) the first time the Account doc is presented to the bank (`mint_promise`, or the `docs[]` parameter of `create_records` / `submit_tx`).

| Key | Value shape |
|---|---|
| `[bankPubkey, "accounts", accountHash]` | `{ account_hash, bank_pubkey, promise_hash, pocket_hash, holder_pubkey, balance }` |

- `balance` can go negative. That is the mutual-credit lifeblood: issuers go negative when they mint (the mint debits their issue account), holders are positive. Sum across every account for a given Promise equals zero.
- The old `pending` / `acknowledged` columns are gone: there is no account-acknowledgement step in the direct-approval model — a holder signing a Tx containing a credit IS their acceptance.

Balance updates are atomic:

```ts
const ok = await kv.atomic()
  .check(res)        // optimistic lock on current value
  .set(key, row)     // new balance as string
  .commit();
```

On conflict, `applyBalanceDelta` retries once.

---

### `ledger_records` — bank-minted ledger entries

Ledger records are created by the bank, identified by ULID, and are NOT content-addressed. The bank assigns ULIDs at creation time and ensures uniqueness per `(ulid, bank_pubkey)`. `pair_ulid` (the peer half of the transfer) is **mandatory** and set at creation. `deal_ulid` is the client-supplied grouping key for all of a deal's records at this bank. `tx_ulid` is internal bookkeeping — set when a holder's signed Tx binds the record at `submit_tx`; the record's wire body carries no Tx back-reference.

| Key | Value shape |
|---|---|
| `[bankPubkey, "ledger_records", ulid]` | `{ ulid, bank_pubkey, type, account, amount, pair_ulid, deal_ulid, tx_ulid, body }` |
| `[bankPubkey, "ledger_records_by_deal", dealUlid, ulid]` | same (secondary index) |

- `type` — `credit` \| `debit`
- `account` — account hash (content-addressed)
- `amount` — string
- `pair_ulid` — peer record ULID (set at creation)
- `deal_ulid` — deal grouping key (client-supplied)
- `tx_ulid` — holder Tx that authorized this record (set at submit_tx)

Insert is atomic across the primary and deal-index keys:

```ts
await kv.atomic()
  .set([bankPubkey, "ledger_records", ulid], row)
  .set([bankPubkey, "ledger_records_by_deal", dealUlid, ulid], row)
  .commit();
```

`getLedgerRecordsByDeal` lists the deal-index prefix and sorts by ULID.

---

### `legs` — per-deal state machine

One row per deal this bank participates in, holding **only its own role, predecessors, and the deal's bank list** — never the full graph (protocol/README.md §2.3 Visibility). Replaces the old `txs` table: state is keyed by the deal ULID, not a Tx hash, because a deal now spans one Tx per holder.

| Key | Value shape |
|---|---|
| `[bankPubkey, "legs", dealUlid]` | `{ state, role, predecessors, banks }` |

- `state` — `created` \| `approved` \| `held` \| `settled` \| `rejected`
- `role` — `"lead"` \| `"follow"` \| `null`
- `predecessors` — bank pubkeys whose settle must be verified first
- `banks` — ALL bank pubkeys in the deal (leads await their holds)

State transitions (protocol/bank-schema.md §2). Wave 1 is client-driven; from `approved` onward the **bank advances itself** (the advance engine runs after `submit_tx` and after every verified signature arriving via `notify_signatures`):

- `create_records` inserts at `created` with `role` / `predecessors` / `banks`.
- `submit_tx` advances to `approved` once every record this bank owns under the deal is bound to a holder-signed Tx and carries a bank per-record `approve`.
- self: `approved → held` — debit accounts locked, deal-level `hold` signed and fanned out.
- self: `held → settled` — a lead settles once it has observed `hold` signatures from every other bank in `banks`; a follower once it has verified `settle` signatures from every bank in `predecessors` (cited in `Signature.seen`). Deltas applied, holds released.
- `reject_deal` (or a received reject) terminates from any pre-`settled` state.

**Important**: `upsertLeg` only updates fields explicitly passed in. A state-only update does not clobber the topology fields set at `create_records`.

---

### `holds` — per-account lock during an in-flight deal

The double-spend gate. A bank acquires a hold on an account when its leg reaches `approved`; releases it on settle / reject.

| Key | Value shape |
|---|---|
| `[bankPubkey, "holds", accountHash]` | `{ deal_ulid, amount, active }` |

At most one active hold per account is enforced by atomic check-and-set on this single key:

```ts
const ok = await kv.atomic()
  .check(res)        // expects no active hold (or same deal for idempotent re-hold)
  .set(key, { deal_ulid, amount, active: true })
  .commit();
```

If another deal already holds the account, `acquireHold` returns false; the advance engine backs off and retries on the next event (or the deal dies via `reject_deal`).

Released holds are kept in place with `active: false`. v1.5 will add an archive sweeper.

---

### `subscriptions` + `subscription_watches` — signature fan-out

The initiating party sends Subscription docs to banks; banks use them to fan out the Signature docs they create. `subscriber_pubkey` is the **delivery target** (`Subscription.to`, defaulting to the creator) — the `notify_signatures` envelope is addressed to it and POSTed to `url`, fire-and-forget.

| Key | Value shape |
|---|---|
| `[bankPubkey, "subscriptions", subscriptionHash]` | `{ subscription_hash, bank_pubkey, subscriber_pubkey, url, until, active }` |
| `[bankPubkey, "subscription_watches", watchKey, subscriptionHash]` | `true` |

- `until` — ISO 8601 expiry (bank defaults ~7 days)
- `active` — boolean; soft-delete flag
- `watchKey` — record ULID, doc hash, or deal ULID

One `subscription_watches` row per watch key — record ULIDs, doc hashes, and deal ULIDs all land in the same `watch_key` space, since a Signature's anchor (`record` / `hash` / `deal`) is looked up the same way regardless of kind.

---

### `replay` — per-sender ULID seen-set

Replay protection for the signed-RPC envelope.

| Key | Value shape |
|---|---|
| `[bankPubkey, "replay", senderPubkey, id, toPubkey]` | `{ created_at: number }` |

The key encodes the replay-detection tuple `(sender, id, to)`. `claimUlid` uses an atomic check-and-set:

```ts
const ok = await kv.atomic()
  .check(res)        // expects key to be absent
  .set(key, { created_at: Date.now() })
  .commit();
```

If the key already exists, the claim fails and the envelope is rejected with `-32002`.

After a successful claim, `pruneReplayWindow` runs in the background and deletes entries older than `REPLAY_WINDOW_MS` (7 days).

---

### `peers` — peer bank URL cache

Each bank maintains a map of `peer_pubkey → peer_url` for banks it has heard from or been subscribed to. Subscription push delivers to the URLs named in Subscription docs; the peer cache supports verifying and replying to pushing banks.

| Key | Value shape |
|---|---|
| `[bankPubkey, "peers", peerPubkey]` | `{ peer_url, last_seen }` |

URLs in this table are trusted on the pubkey side, not the URL side — the cryptographic guarantees come from verifying signatures against `peer_pubkey`. A misconfigured URL produces a failed push (recovered by client relay), not a silent compromise.

---

## Address directory

The address directory is exposed outside RPC as two HTTP endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/<name>/address/<pubkey>` | Return the stored Address doc for a pubkey |
| `POST` | `/<name>/address` | Submit a new or updated Address doc |

Address docs are stored as `type: "address"` under `[bankPubkey, "docs", hash]`, where `hash` is the base58 hash of the signed doc. The directory lets clients map pubkeys to a human-readable name and push-receipt URL without leaking that mapping into RPC signatures.

---

## Invariants the bank enforces in code

These are not enforced by KV alone; they live in the bank handlers and the advance engine.

- **Bank-minted records**: `mint_promise` and `create_records` are the only paths that create `ledger_records` rows. The bank assigns ULIDs and the mandatory `pair_ulid`. Clients never create record bodies.
- **Sum invariant per Promise**: for any `promise_hash`, the sum of `balance` across all accounts at the issuing bank equals zero. Value only moves in debit/credit pairs (the mint included), so the invariant holds structurally.
- **Issuer-only Promises**: a Promise's `bank` field equals the pubkey of the bank that stored it; no bank stores Promises issued by another bank.
- **No Pocket bodies**: doc intake rejects `type: "pocket"` outright.
- **One active hold per account**: the single-key atomic check-and-set on `[bankPubkey, "holds", accountHash]` enforces this.
- **`submit_tx` preconditions**: every record the bank owns in `tx.records` must sit on an account whose holder is `tx.pubkey`, belong to a single deal, and not be bound to a different Tx. The per-record approve policy: credits always approve; non-issuer debits require `balance − active holds − amount ≥ 0`; issuer debits are bounded only by `Promise.limit`.
- **Settle preconditions** (advance engine): leg is `held`; a lead has observed `hold` signatures from every other bank in `banks`; a follower has verified `settle` signatures from every predecessor and cites them in `seen`. Settling is idempotent-by-state — a leg's deltas are never applied twice.

---

## What's not in v1

- **No automatic archival.** Released holds and old replay-window rows accumulate. v1.5 ships the sweeper (which should also reap orphaned `created`-state legs whose holders never signed).
- **No push delivery queue.** Fan-out is a fire-and-forget POST at signature-creation time; there is no outbox table or retry. Client relay (`notify_signatures`) is the recovery path.
- **No backup story beyond Deno Deploy defaults.** Production banks need explicit backup discipline; v1 demo relies on Deno KV's managed durability.
- **No schema-evolution migrations after launch.** v1 policy: if the schema needs to change, wipe demo banks. v1.5 introduces forward-compatible migrations.
