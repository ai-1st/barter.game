# Database schema — v1 (Reference Implementation)

> **This is an implementation detail, not a protocol invariant.** The barter.game v1 protocol ([`PROTOCOL.md`](./PROTOCOL.md) §9) requires certain correctness guarantees — sum-to-zero, at most one active hold per account, atomic state transitions — but it does not mandate Postgres, Supabase, or any specific schema. You may use SQLite, LevelDB, DynamoDB, or a custom store as long as you enforce the same invariants.
>
> This document describes the schema used by the v1 reference implementation. Treat it as a working example, not a contract.

barter.game v1 runs on Postgres (managed by Supabase). One database backs
all banks in a deployment; rows are scoped to a bank by a `bank_pubkey`
column on every bank-scoped table. There is no RLS in v1 — the Edge
Function holds the trust boundary, and direct DB access is operator-only.

Migrations live in `supabase/migrations/`. Apply with `supabase db push`.

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
This is the bank's eternal append-only history. Account balances are
derived from the doc stream (with the `accounts` table as an
optimization).

```sql
CREATE TABLE docs (
  hash         TEXT NOT NULL,                  -- base58(sha256(canonical(doc)))
  bank_pubkey  TEXT NOT NULL,                  -- which bank holds this doc
  type         TEXT NOT NULL,                  -- promise|pocket|account|tx|credit|debit|signature
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
doc twice is a no-op, which makes RPC retries safe.

### `accounts` — per-(promise, holder) balance optimization

The issuer bank maintains a balance row per Account. This is derivable
from the doc stream, but materializing it makes balance queries O(1)
and makes the sum invariant trivially checkable.

```sql
CREATE TABLE accounts (
  account_hash    TEXT PRIMARY KEY,            -- hash of the Account doc
  bank_pubkey     TEXT NOT NULL,               -- issuing bank
  promise_hash    TEXT NOT NULL,               -- which Promise
  pocket_hash     TEXT NOT NULL,               -- holder's Pocket doc hash
  holder_pubkey   TEXT NOT NULL,               -- account owner
  balance         NUMERIC NOT NULL DEFAULT 0,  -- realized balance (can go negative)
  pending         NUMERIC NOT NULL DEFAULT 0,  -- committed but unacked inbound
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,  -- holder signed ack on this Account
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX accounts_by_holder  ON accounts (bank_pubkey, holder_pubkey);
CREATE INDEX accounts_by_promise ON accounts (bank_pubkey, promise_hash);
```

- **`balance` can go negative.** That is the mutual-credit lifeblood:
  issuers go negative when they mint, holders are positive. Sum across
  every account for a given Promise equals zero (or the agreed limit).
- **`pending`** counts committed-but-not-yet-`ack`d inbound transfers.
  Visible in `get_account_balance` so users see incoming funds.
- **`acknowledged`** flips true when the holder signs an `ack` doc
  claiming the Account. Issuer's own account on its own Promise is
  auto-acknowledged at creation.

The trigger `accounts_touch_updated_at` bumps `updated_at` on every
update.

### `txs` — per-Tx state machine

One row per bank that's participating in a Tx. Every participating bank keeps
its own row with the same `tx_hash`, holding **only its own role and
predecessors** — never the full graph (PROTOCOL.md §2 Visibility).

```sql
CREATE TABLE txs (
  tx_hash       TEXT NOT NULL,
  bank_pubkey   TEXT NOT NULL,
  state         TEXT NOT NULL,                  -- approved|held|confirmed|settled|rejected
  role          TEXT,                           -- 'lead' | 'follow'
  predecessors  JSONB NOT NULL DEFAULT '[]',    -- bank pubkeys whose settle must be seen first
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, bank_pubkey)
);

CREATE INDEX txs_by_state ON txs (bank_pubkey, state, updated_at DESC);
```

The `lead_bank_pubkey` / `follow_bank_pubkey` columns from the initial schema
are dropped and replaced by `role` + `predecessors` in migration
`20260531000000_nparty_txs.sql`. Under the client-orchestrated model a bank
cannot name "the other bank" (there may be many, and it doesn't see them) — it
only knows its role and the predecessor banks whose `settle` it must observe.

State transitions are owned by the handlers (all driven by the client):

- `mint_promise` / `open_account` don't touch this table.
- `propose_leg` inserts at `approved` with this bank's `role` + `predecessors`.
- `hold_leg` advances to `held`.
- `confirm_receipt` advances to `confirmed` once **every holder in this bank's
  own records** has stored a `settle`-action signature.
- `settle_leg` advances to `settled` after verifying each predecessor's
  `settle`; `reject_leg` terminates from any pre-`settled` state.

**Important**: `upsertTx` only updates fields explicitly passed in. A state-only
update (e.g. `{state: "held"}`) does not clobber `role` / `predecessors` set on
the `propose_leg` call.

### `holds` — per-(account, tx) lock during in-flight Tx

The double-spend gate. A bank acquires a row here when it signs `hold`
for one of its accounts; releases it on `settle` / `reject` / 24h
abandonment sweep.

```sql
CREATE TABLE holds (
  account_hash  TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  bank_pubkey   TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at   TIMESTAMPTZ,
  PRIMARY KEY (account_hash, tx_hash, bank_pubkey)
);

-- Double-spend gate: only ONE active hold per account at a time.
CREATE UNIQUE INDEX holds_one_active_per_account
  ON holds (account_hash, bank_pubkey)
  WHERE active;

CREATE INDEX holds_active_by_bank ON holds (bank_pubkey, active, created_at);
```

The partial unique index `holds_one_active_per_account` is the
load-bearing concurrency primitive. When two concurrent Txs both try
to hold the same account, Postgres raises `unique_violation` on the
second attempt; the handler translates this to RPC error `-32003`.

Released rows stay in the table (with `active = FALSE` and a
`released_at` timestamp). v1.5 will add an archive sweeper.

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

The "whichever set is larger" wording in the design doc means a sender
that sends 200 IDs in an hour keeps 100; a sender that sends 5 IDs over
two weeks keeps all 5 (assuming they're within the 7-day window).

### `bank_peers` — peer bank URL cache

Each bank maintains a map of `peer_pubkey → peer_url` for banks it has
heard from. Populated by `propose_trade` (lead bank remembers follow)
and `approve_trade` (follow bank remembers lead). Used by
`forward_confirm` and `notify_settle` to call back.

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
`peer_pubkey`. A misconfigured URL produces a failed RPC, not a
silent compromise.

---

## Helpers

### `touch_updated_at()` trigger function

Bumps `updated_at` on every `UPDATE` to `accounts` and `txs`.

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

These are not enforced by the schema; they live in the bank handlers.

- **Sum invariant per Promise**: for any `promise_hash`, the sum of
  `balance` across all accounts at the issuing bank equals zero (or
  `+limit` / `-limit` if a limit is set).
- **Issuer-only Promises**: a Promise's `bank` field equals the
  pubkey of the bank that stored it; no bank stores Promises issued
  by another bank.
- **One Active Hold per Account**: the partial unique index enforces
  this at the DB layer. Per-Promise locks are NOT enforced (a Promise
  has many accounts, each lockable independently).
- **`approve_trade` precondition**: the calling bank is the lead bank
  for the Tx; the local txs row state is `proposed`.
- **`settle` precondition**: txs.state == `confirmed`, and the calling
  bank is the lead bank.

---

## What's not in v1

- **No RLS policies.** Each Edge Function uses the service-role key.
  v1.5 adds per-function RLS when third-party operators share a project.
- **No automatic archival.** Released holds and old replay-window rows
  accumulate. v1.5 ships the sweeper.
- **No backup story beyond Supabase defaults.** Production banks need
  explicit backup discipline; v1 demo relies on Supabase PITR.
- **No schema-evolution migrations after launch.** v1 policy: if the
  schema needs to change, wipe demo banks. v1.5 introduces forward-
  compatible migrations.
- **No `apply_balance_delta` stored procedure.** The `db.applyBalanceDelta`
  method has an inline fallback (`SELECT FOR UPDATE` + `UPDATE`). The
  inline path is correct for the single-writer-per-bank case Edge
  Functions are in; the RPC path is a future optimization.
