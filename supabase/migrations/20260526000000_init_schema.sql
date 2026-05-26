-- barter.game v1 initial schema.
--
-- Design: see ~/.gstack/projects/barter.game/xo-main-design-20260526-145322.md.
-- Multi-tenant: one Supabase project, N bank functions, all rows scoped by
-- `bank_pubkey`. v1 has no RLS — each Edge Function holds the trust boundary;
-- direct DB access is operator-only. RLS adds in v1.5 when third-party banks
-- start sharing the project.
--
-- All hashes / pubkeys / sigs are base58 strings stored as TEXT. Numeric
-- balances use NUMERIC for exact arithmetic — float drift is unacceptable
-- in a ledger.

-- ─────────────────────────────────────────────────────────────────────────
-- docs: content-addressed store of every signed doc the bank has ever seen
-- ─────────────────────────────────────────────────────────────────────────
--
-- Storing every doc by hash gives the bank a verifiable append-only history.
-- The `body` JSONB is the doc as received over the wire (canonicalize-able
-- back to the same hash). The `bank_pubkey` is which bank this doc lives at
-- — multi-tenancy column.

CREATE TABLE docs (
  hash         TEXT NOT NULL,            -- base58(SHA-256(canonical(doc)))
  bank_pubkey  TEXT NOT NULL,            -- which bank holds this doc
  type         TEXT NOT NULL,            -- promise | pocket | account | tx | credit | debit | signature
  pubkey       TEXT NOT NULL,            -- doc.pubkey (owner / signer)
  body         JSONB NOT NULL,           -- the full signed doc
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hash, bank_pubkey)
);

CREATE INDEX docs_by_type_pubkey ON docs (bank_pubkey, type, pubkey);
CREATE INDEX docs_by_created_at  ON docs (bank_pubkey, created_at DESC);

COMMENT ON TABLE docs IS 'Content-addressed signed doc archive. PK is (hash, bank_pubkey) so the same hash can in principle live at multiple banks (separate observers), though in v1 each promise has a single issuing bank.';

-- ─────────────────────────────────────────────────────────────────────────
-- accounts: per-(promise, holder) balance row maintained by the issuing bank
-- ─────────────────────────────────────────────────────────────────────────
--
-- The issuing bank is the sole authority for balances of its Promises.
-- `balance` is the holder's current realized balance. Issuers go negative
-- when they mint (Alice mints 10 logo → Alice's account row balance = -10).
-- `pending` reserves committed-but-not-yet-acknowledged inbound transfers.
--
-- The account_hash IS the doc hash of the Account doc — same content-address
-- scheme as everything else.

CREATE TABLE accounts (
  account_hash    TEXT PRIMARY KEY,        -- hash of the Account doc
  bank_pubkey     TEXT NOT NULL,           -- issuing bank (sole authority for this row)
  promise_hash    TEXT NOT NULL,           -- which Promise this account holds
  pocket_hash     TEXT NOT NULL,           -- holder's Pocket doc hash
  holder_pubkey   TEXT NOT NULL,           -- holder's pubkey (account owner)
  balance         NUMERIC NOT NULL DEFAULT 0,
  pending         NUMERIC NOT NULL DEFAULT 0,
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,  -- holder has signed `ack`
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX accounts_by_holder  ON accounts (bank_pubkey, holder_pubkey);
CREATE INDEX accounts_by_promise ON accounts (bank_pubkey, promise_hash);
-- A holder has at most one Account per Promise per Pocket at a given bank.
-- Multiple Pockets on the same Promise are allowed (different "wallets"); the
-- constraint below would be too strict. We let the bank enforce
-- "single Account per (promise, holder, pocket)" in code instead, since the
-- Account doc hash already encodes that triple via canonical JSON.

COMMENT ON TABLE accounts IS 'Per-promise per-holder balance. balance can be negative for issuers (mutual credit). pending counts committed-but-unack-ed inbound transfers.';

-- ─────────────────────────────────────────────────────────────────────────
-- txs: per-Tx state machine
-- ─────────────────────────────────────────────────────────────────────────
--
-- One row per Tx the bank participates in. State advances via the protocol
-- (proposed → approved → held → confirmed → settled), with reject as the
-- terminal error path. `lead_bank_pubkey` is which bank acts as lead per
-- the lead/follow risk model.

CREATE TABLE txs (
  tx_hash             TEXT NOT NULL,
  bank_pubkey         TEXT NOT NULL,
  state               TEXT NOT NULL,        -- proposed | approved | held | confirmed | settled | rejected
  lead_bank_pubkey    TEXT,                 -- bank that received propose_trade from a user
  follow_bank_pubkey  TEXT,                 -- the peer bank (NULL for same-bank Txs)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, bank_pubkey)
);

CREATE INDEX txs_by_state ON txs (bank_pubkey, state, updated_at DESC);

COMMENT ON TABLE txs IS 'Per-bank state machine for a Tx. Lead and follow banks each maintain their own row; same Tx hash, different bank_pubkey.';

-- ─────────────────────────────────────────────────────────────────────────
-- holds: per-Promise-per-Account lock during in-flight Tx
-- ─────────────────────────────────────────────────────────────────────────
--
-- A row exists when a bank has signed `hold` for one of the Tx's credit
-- legs. Auto-released on settle / reject / 24h abandonment sweeper.
-- A partial unique index enforces "at most one ACTIVE hold per Account".
-- This is the double-spend gate.

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

-- Double-spend gate: only one ACTIVE hold per Account at a time.
CREATE UNIQUE INDEX holds_one_active_per_account
  ON holds (account_hash, bank_pubkey)
  WHERE active;

CREATE INDEX holds_active_by_bank ON holds (bank_pubkey, active, created_at);

COMMENT ON TABLE holds IS 'Per-(account, tx) hold record. Partial unique index enforces single-active-hold-per-account: concurrent hold attempts return -32003.';

-- ─────────────────────────────────────────────────────────────────────────
-- replay_window: per-sender ULID seen set
-- ─────────────────────────────────────────────────────────────────────────
--
-- Stores `(sender_pubkey, id, to_pubkey)` tuples for the sliding window.
-- Per design: keep last 100 IDs per sender AND any ID seen within 1h
-- (whichever is larger). The pg_cron sweeper enforces the eviction.

CREATE TABLE replay_window (
  sender_pubkey  TEXT NOT NULL,
  id             TEXT NOT NULL,      -- ULID
  to_pubkey      TEXT NOT NULL,      -- recipient bank pubkey (so cross-bank replays don't collide)
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_pubkey, id, to_pubkey)
);

CREATE INDEX replay_window_by_sender_time ON replay_window (sender_pubkey, seen_at DESC);

COMMENT ON TABLE replay_window IS 'Replay protection sliding window. Sweeper evicts rows by per-sender LRU (keep last 100) plus any row >7d idle.';

-- ─────────────────────────────────────────────────────────────────────────
-- helper: updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_touch_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER txs_touch_updated_at
  BEFORE UPDATE ON txs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
