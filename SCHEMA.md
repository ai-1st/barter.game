# Database schema — v1 (Reference Implementation)

> **This is an implementation detail, not a protocol invariant.** The barter.game v1 protocol ([`PROTOCOL.md`](./PROTOCOL.md) §8–§9) requires certain correctness guarantees — sum-to-zero, at most one active hold per account, atomic state transitions — but it does not mandate Postgres, Supabase, or any specific schema. You may use SQLite, LevelDB, DynamoDB, or a custom store as long as you enforce the same invariants.
>
> This document describes the schema used by the v1 reference implementation. Treat it as a working example, not a contract.

barter.game v1 runs on Postgres (managed by Supabase). One database backs
all banks in a deployment; rows are scoped to a bank by a `bank_pubkey`
column on every bank-scoped table. There is no RLS in v1 — the Edge
Function holds the trust boundary, and direct DB access is operator-only.

Migrations live in `supabase/migrations/`. Apply with `supabase db push`.
The schema was re-baselined into a single init migration
(`20260612000000_init_schema.sql`) when the direct-approval model landed —
per the v1 policy, demo banks are wiped on schema change.

---

## Conventions

- **`base58 TEXT`** — all hashes, pubkeys, and signatures are stored as
  base58 strings, in `TEXT` columns. No binary types.
- **`bank_pubkey TEXT NOT NULL`** — multi-tenant filter column on every
  bank-scoped table. Every query goes through it; missing this filter
  is a bug.
- **`NUMERIC` for balances** — exact arithmetic; never `REAL`/`DOUBLE`.
  Ledgers don't tolerate float drift.
- **`TIMESTAMPTZ` for time** — always with timezone; `DEFAULT NOW()`
  unless we need a client-supplied time.
- **`ULID TEXT`** — Crockford base32, sortable by emission time.

---

## Tables

### `docs` — content-addressed signed-doc archive

Every signed doc the bank has ever seen, keyed by its content hash.
This is the bank's eternal append-only history for content-addressed
docs: Promise, Account, Tx, Signature, Order, and Subscription.
Ledger records are NOT stored here (they live in `ledger_records`),
and **Pocket bodies never reach a bank** — accounts reference pockets
by opaque hash.

```sql
CREATE TABLE docs (
  hash         TEXT NOT NULL,                  -- base58(sha256(canonical(doc)))
  bank_pubkey  TEXT NOT NULL,                  -- which bank holds this doc
  type         TEXT NOT NULL,                  -- promise|account|tx|signature|order|subscription
  pubkey       TEXT NOT NULL,                  -- doc.pubkey (owner / signer)
  body         JSONB NOT NULL,                 -- the full signed doc
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hash, bank_pubkey)
);

CREATE INDEX docs_by_type_pubkey ON docs (bank_pubkey, type, pubkey);
CREATE INDEX docs_by_created_at  ON docs (bank_pubkey, created_at DESC);
```

The PK is `(hash, bank_pubkey)` rather than just `hash`, so the same
canonical hash could in principle live at multiple banks (different
observers of the same Promise). In v1 each Promise has one issuer
bank, so this is mostly a defensive choice.

Inserts use `ON CONFLICT DO NOTHING` semantics — receiving the same
doc twice is a no-op, which makes RPC retries and signature relays safe.

Signature docs are queried by their anchor fields (`body.record`,
`body.hash`, `body.deal`) via JSONB containment — the advance engine's
"have I seen the predecessor's settle?" checks and `get_deal`'s
signature listing both run against this table.

### `ledger_records` — bank-minted ledger entries

Ledger records are created by the bank, identified by ULID, and are
NOT content-addressed. The bank assigns ULIDs at creation time and
ensures uniqueness per `(ulid, bank_pubkey)`. `pair_ulid` (the peer
half of the transfer) is **mandatory** and set at creation. `deal_ulid`
is the client-supplied grouping key for all of a deal's records at this
bank. `tx_ulid` is internal bookkeeping — set when a holder's signed Tx
binds the record at `submit_tx`; the record's wire body carries no Tx
back-reference.

```sql
CREATE TABLE ledger_records (
  ulid         TEXT NOT NULL,
  bank_pubkey  TEXT NOT NULL,
  type         TEXT NOT NULL,        -- credit | debit
  account      TEXT NOT NULL,        -- account hash (content-addressed)
  amount       NUMERIC NOT NULL,
  pair_ulid    TEXT NOT NULL,        -- peer record ULID (set at creation)
  deal_ulid    TEXT NOT NULL,        -- deal grouping key (client-supplied)
  tx_ulid      TEXT,                 -- holder Tx that authorized this record (set at submit_tx)
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ulid, bank_pubkey)
);

CREATE INDEX ledger_records_by_account ON ledger_records (bank_pubkey, account);
CREATE INDEX ledger_records_by_deal ON ledger_records (bank_pubkey, deal_ulid);
```

### `accounts` — per-(promise, holder) balance optimization

The issuer bank maintains a balance row per Account. This is derivable
from the doc stream, but materializing it makes balance queries O(1)
and makes the sum invariant trivially checkable.

Rows are created **lazily** — accounts are implicit; the row appears
(at balance 0) the first time the Account doc is presented to the bank
(`mint_promise`, or the `docs[]` parameter of `create_records` /
`submit_tx`).

```sql
CREATE TABLE accounts (
  account_hash    TEXT PRIMARY KEY,            -- hash of the Account doc
  bank_pubkey     TEXT NOT NULL,               -- issuing bank
  promise_hash    TEXT NOT NULL,               -- which Promise
  pocket_hash     TEXT NOT NULL,               -- holder's Pocket doc hash (opaque)
  holder_pubkey   TEXT NOT NULL,               -- account owner
  balance         NUMERIC NOT NULL DEFAULT 0,  -- realized balance (can go negative)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX accounts_by_holder  ON accounts (bank_pubkey, holder_pubkey);
CREATE INDEX accounts_by_promise ON accounts (bank_pubkey, promise_hash);
```

- **`balance` can go negative.** That is the mutual-credit lifeblood:
  issuers go negative when they mint (the mint debits their issue
  account), holders are positive. Sum across every account for a given
  Promise equals zero.
- The old `pending` / `acknowledged` columns are gone: there is no
  account-acknowledgement step in the direct-approval model — a holder
  signing a Tx containing a credit IS their acceptance.

The trigger `accounts_touch_updated_at` bumps `updated_at` on every
update.

### `deal_legs` — per-(deal, bank) state machine

One row per deal this bank participates in, holding **only its own
role, predecessors, and the deal's bank list** — never the full graph
(PROTOCOL.md §2.3 Visibility). Replaces the old `txs` table: state is
keyed by the deal ULID, not a Tx hash, because a deal now spans one Tx
per holder.

```sql
CREATE TABLE deal_legs (
  deal_ulid     TEXT NOT NULL,
  bank_pubkey   TEXT NOT NULL,
  state         TEXT NOT NULL,                  -- created|approved|held|settled|rejected
  role          TEXT,                           -- 'lead' | 'follow'
  predecessors  JSONB NOT NULL DEFAULT '[]',    -- bank pubkeys whose settle must be verified first
  banks         JSONB NOT NULL DEFAULT '[]',    -- ALL bank pubkeys in the deal (leads await their holds)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_ulid, bank_pubkey)
);

CREATE INDEX deal_legs_by_state ON deal_legs (bank_pubkey, state, updated_at DESC);
```

State transitions (PROTOCOL.md §8). Wave 1 is client-driven; from
`approved` onward the **bank advances itself** (the advance engine runs
after `submit_tx` and after every verified signature arriving via
`notify_signatures`):

- `create_records` inserts at `created` with `role` / `predecessors` /
  `banks`.
- `submit_tx` advances to `approved` once every record this bank owns
  under the deal is bound to a holder-signed Tx and carries a bank
  per-record `approve`.
- self: `approved → held` — debit accounts locked, deal-level `hold`
  signed and fanned out.
- self: `held → settled` — a lead settles once it has observed `hold`
  signatures from every other bank in `banks`; a follower once it has
  verified `settle` signatures from every bank in `predecessors`
  (cited in `Signature.seen`). Deltas applied, holds released.
- `reject_deal` (or a received reject) terminates from any
  pre-`settled` state.

**Important**: `upsertLeg` only updates fields explicitly passed in. A
state-only update does not clobber the topology fields set at
`create_records`.

### `holds` — per-(account, deal) lock during an in-flight deal

The double-spend gate. A bank acquires a row here when its leg reaches
`approved`; releases it on settle / reject / abandonment sweep.

```sql
CREATE TABLE holds (
  account_hash  TEXT NOT NULL,
  deal_ulid     TEXT NOT NULL,
  bank_pubkey   TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at   TIMESTAMPTZ,
  PRIMARY KEY (account_hash, deal_ulid, bank_pubkey)
);

-- Double-spend gate: only ONE active hold per account at a time.
CREATE UNIQUE INDEX holds_one_active_per_account
  ON holds (account_hash, bank_pubkey)
  WHERE active;

CREATE INDEX holds_active_by_bank ON holds (bank_pubkey, active, created_at);
```

The partial unique index `holds_one_active_per_account` is the
load-bearing concurrency primitive. When two in-flight deals try to
hold the same account, Postgres raises `unique_violation` on the
second attempt; the advance engine backs off and retries on the next
event (or the deal dies via `reject_deal`).

Released rows stay in the table (with `active = FALSE` and a
`released_at` timestamp). v1.5 will add an archive sweeper.

### `subscriptions` + `subscription_watches` — signature fan-out

The initiating party sends Subscription docs to banks; banks use them
to fan out the Signature docs they create. `subscriber_pubkey` is the
**delivery target** (`Subscription.to`, defaulting to the creator) —
the `notify_signatures` envelope is addressed to it and POSTed to
`url`, fire-and-forget.

```sql
CREATE TABLE subscriptions (
  subscription_hash  TEXT NOT NULL,    -- hash of the Subscription doc
  bank_pubkey        TEXT NOT NULL,
  subscriber_pubkey  TEXT NOT NULL,    -- delivery target behind url
  url                TEXT NOT NULL,
  until              TIMESTAMPTZ,      -- expiry (bank defaults ~7 days)
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_hash, bank_pubkey)
);

CREATE TABLE subscription_watches (
  bank_pubkey        TEXT NOT NULL,
  watch_key          TEXT NOT NULL,    -- record ULID | doc hash | deal ULID
  subscription_hash  TEXT NOT NULL,
  PRIMARY KEY (bank_pubkey, watch_key, subscription_hash)
);

CREATE INDEX subscription_watches_by_key ON subscription_watches (bank_pubkey, watch_key);
```

One `subscription_watches` row per watch key — record ULIDs, doc
hashes, and deal ULIDs all land in the same `watch_key` column, since
a Signature's anchor (`record` / `hash` / `deal`) is looked up the
same way regardless of kind.

### `replay_window` — per-sender ULID seen-set

Replay protection for the signed-RPC envelope.

```sql
CREATE TABLE replay_window (
  sender_pubkey  TEXT NOT NULL,
  id             TEXT NOT NULL,       -- the envelope's ULID
  to_pubkey      TEXT NOT NULL,       -- recipient bank (prevents cross-bank replay)
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_pubkey, id, to_pubkey)
);

CREATE INDEX replay_window_by_sender_time
  ON replay_window (sender_pubkey, seen_at DESC);
```

The PK is the replay-detection key. `claimUlid` does
`INSERT … ON CONFLICT` and returns false on conflict — that result
becomes `-32002`.

The sweeper enforces:
1. Per-sender LRU cap: keep the 100 most recent IDs.
2. Idle TTL: drop anything older than 7 days.

### `bank_peers` — peer bank URL cache

Each bank maintains a map of `peer_pubkey → peer_url` for banks it has
heard from or been subscribed to. Subscription push delivers to the
URLs named in Subscription docs; the peer cache supports verifying and
replying to pushing banks.

```sql
CREATE TABLE bank_peers (
  bank_pubkey  TEXT NOT NULL,        -- the bank doing the bookkeeping
  peer_pubkey  TEXT NOT NULL,        -- the peer we know about
  peer_url     TEXT NOT NULL,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_pubkey, peer_pubkey)
);

CREATE INDEX bank_peers_by_bank ON bank_peers (bank_pubkey, last_seen DESC);
```

URLs in this table are trusted on the pubkey side, not the URL side —
the cryptographic guarantees come from verifying signatures against
`peer_pubkey`. A misconfigured URL produces a failed push (recovered by
client relay), not a silent compromise.

---

## Helpers

### `touch_updated_at()` trigger function

Bumps `updated_at` on every `UPDATE` to `accounts` and `deal_legs`.

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## Invariants the bank enforces in code

These are not enforced by the schema; they live in the bank handlers
and the advance engine.

- **Bank-minted records**: `mint_promise` and `create_records` are the
  only paths that create `ledger_records` rows. The bank assigns ULIDs
  and the mandatory `pair_ulid`. Clients never create record bodies.
- **Sum invariant per Promise**: for any `promise_hash`, the sum of
  `balance` across all accounts at the issuing bank equals zero. Value
  only moves in debit/credit pairs (the mint included), so the invariant
  holds structurally.
- **Issuer-only Promises**: a Promise's `bank` field equals the
  pubkey of the bank that stored it; no bank stores Promises issued
  by another bank.
- **No Pocket bodies**: doc intake rejects `type: "pocket"` outright.
- **One active hold per account**: the partial unique index enforces
  this at the DB layer.
- **`submit_tx` preconditions**: every record the bank owns in
  `tx.records` must sit on an account whose holder is `tx.pubkey`,
  belong to a single deal, and not be bound to a different Tx. The
  per-record approve policy: credits always approve; non-issuer debits
  require `balance − active holds − amount ≥ 0`; issuer debits are
  bounded only by `Promise.limit`.
- **Settle preconditions** (advance engine): leg is `held`; a lead has
  observed `hold` signatures from every other bank in `banks`; a
  follower has verified `settle` signatures from every predecessor and
  cites them in `seen`. Settling is idempotent-by-state — a leg's
  deltas are never applied twice.

---

## What's not in v1

- **No RLS policies.** Each Edge Function uses the service-role key.
  v1.5 adds per-function RLS when third-party operators share a project.
- **No automatic archival.** Released holds and old replay-window rows
  accumulate. v1.5 ships the sweeper (which should also reap orphaned
  `created`-state legs whose holders never signed).
- **No push delivery queue.** Fan-out is a fire-and-forget POST at
  signature-creation time; there is no outbox table or retry. Client
  relay (`notify_signatures`) is the recovery path.
- **No backup story beyond Supabase defaults.** Production banks need
  explicit backup discipline; v1 demo relies on Supabase PITR.
- **No schema-evolution migrations after launch.** v1 policy: if the
  schema needs to change, wipe demo banks (this re-baseline did exactly
  that). v1.5 introduces forward-compatible migrations.
- **No `apply_balance_delta` stored procedure.** The `db.applyBalanceDelta`
  method has an inline fallback (`SELECT FOR UPDATE` + `UPDATE`). The
  inline path is correct for the single-writer-per-bank case Edge
  Functions are in; the RPC path is a future optimization.
