-- barter.game v1 schema — direct-approval settlement model.
--
-- Clean re-baseline (2026-06-12): per the v1 migration policy demo banks are
-- wiped on schema change, so the previous four migrations are squashed into
-- this single init.
--
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
-- — multi-tenancy column. Banks store the docs presented to them; the only
-- artifacts a bank creates are ledger records and signatures. Account bodies
-- never reach a bank — accounts reference accounts by opaque hash.

CREATE TABLE docs (
  hash         TEXT NOT NULL,            -- base58(SHA-256(canonical(doc)))
  bank_pubkey  TEXT NOT NULL,            -- which bank holds this doc
  type         TEXT NOT NULL,            -- voucher | account | tx | credit | debit | signature | order | subscription
  pubkey       TEXT NOT NULL,            -- doc.pubkey (owner / signer)
  body         JSONB NOT NULL,           -- the full signed doc
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hash, bank_pubkey)
);

CREATE INDEX docs_by_type_pubkey ON docs (bank_pubkey, type, pubkey);
CREATE INDEX docs_by_created_at  ON docs (bank_pubkey, created_at DESC);

COMMENT ON TABLE docs IS 'Content-addressed signed doc archive. PK is (hash, bank_pubkey) so the same hash can in principle live at multiple banks (separate observers), though in v1 each voucher has a single issuing bank.';

-- ─────────────────────────────────────────────────────────────────────────
-- accounts: per-(voucher, holder, account) balance row at the issuing bank
-- ─────────────────────────────────────────────────────────────────────────
--
-- The issuing bank is the sole authority for balances of its Vouchers.
-- Accounts are implicit: a row is created the first time the Account doc is
-- presented with any request (mint_voucher, create_records, submit_tx) — no
-- open_account call. Issuers go negative when they mint: the mint is itself
-- the first ledger record pair, debiting the issue account.

CREATE TABLE accounts (
  account_hash    TEXT PRIMARY KEY,        -- hash of the Account doc
  bank_pubkey     TEXT NOT NULL,           -- issuing bank (sole authority for this row)
  voucher_hash    TEXT NOT NULL,           -- which Voucher this account holds
  account_hash     TEXT NOT NULL,           -- holder's Account doc hash (opaque to the bank)
  holder_pubkey   TEXT NOT NULL,           -- holder's pubkey (account owner)
  balance         NUMERIC NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX accounts_by_holder  ON accounts (bank_pubkey, holder_pubkey);
CREATE INDEX accounts_by_voucher ON accounts (bank_pubkey, voucher_hash);

COMMENT ON TABLE accounts IS 'Per-voucher per-holder balance. balance can be negative for issuers (mutual credit). Rows are created lazily when an Account doc is first presented.';

-- ─────────────────────────────────────────────────────────────────────────
-- ledger_records: bank-minted, ULID-identified, grouped by deal
-- ─────────────────────────────────────────────────────────────────────────
--
-- Ledger records are bank-minted, ULID-identified, and NOT content-addressed.
-- The bank assigns ULIDs at creation and cross-references the two halves of
-- a transfer via `pair_ulid` (mandatory). `deal_ulid` is the client-supplied
-- orchestration key grouping all records of one deal at this bank.
-- `tx_ulid` is internal bookkeeping: set when a holder's signed Tx binds the
-- record (the record's wire body carries no Tx back-reference).

CREATE TABLE ledger_records (
  ulid         TEXT NOT NULL,
  bank_pubkey  TEXT NOT NULL,
  type         TEXT NOT NULL,        -- credit | debit
  account      TEXT NOT NULL,        -- account hash (still content-addressed)
  amount       NUMERIC NOT NULL,
  pair_ulid    TEXT NOT NULL,        -- peer record ULID (set at creation)
  deal_ulid    TEXT NOT NULL,        -- deal grouping key (client-supplied)
  tx_ulid      TEXT,                 -- holder Tx that authorizes this record (set at submit_tx)
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ulid, bank_pubkey)
);

CREATE INDEX ledger_records_by_account ON ledger_records (bank_pubkey, account);
CREATE INDEX ledger_records_by_deal ON ledger_records (bank_pubkey, deal_ulid);

COMMENT ON TABLE ledger_records IS 'Bank-minted ledger entries identified by ULID, not content hash. pair_ulid links the debit/credit halves; deal_ulid groups a deal''s records; tx_ulid binds a record to the holder Tx that authorized it.';

-- ─────────────────────────────────────────────────────────────────────────
-- deal_legs: per-(deal, bank) state machine
-- ─────────────────────────────────────────────────────────────────────────
--
-- One row per deal this bank participates in. Banks self-advance:
--   created  → records exist
--   approved → every record this bank owns is bound to a holder-signed Tx
--              and carries a bank approve signature
--   held     → debit accounts locked, hold signed + fanned out
--   settled  → balances applied, holds released, settle signed (terminal)
--   rejected → holds released, reject signed (terminal)
-- `role`/`predecessors`/`banks` carry the client-computed settle topology:
-- lead legs settle once they have seen holds from every bank in `banks`;
-- follow legs settle once they have verified settles from `predecessors`.

CREATE TABLE deal_legs (
  deal_ulid     TEXT NOT NULL,
  bank_pubkey   TEXT NOT NULL,
  state         TEXT NOT NULL,        -- created | approved | held | settled | rejected
  role          TEXT,                 -- 'lead' | 'follow' (settle-topology role)
  predecessors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  banks         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_ulid, bank_pubkey)
);

CREATE INDEX deal_legs_by_state ON deal_legs (bank_pubkey, state, updated_at DESC);

COMMENT ON TABLE deal_legs IS 'Per-bank leg state for a deal. role/predecessors/banks are client-supplied orchestration hints; authority flows only from signed artifacts (holder Tx sigs, per-record approvals, settle sigs).';
COMMENT ON COLUMN deal_legs.predecessors IS 'JSON array of bank pubkeys whose settle this bank must observe (Signature.seen) before settling its own leg.';
COMMENT ON COLUMN deal_legs.banks IS 'JSON array of ALL bank pubkeys in the deal. Lead legs wait for hold signatures from every other listed bank before settling first.';

-- ─────────────────────────────────────────────────────────────────────────
-- holds: per-Account lock during an in-flight deal
-- ─────────────────────────────────────────────────────────────────────────
--
-- A row exists when a bank has locked a debit account for a deal. Released
-- on settle / reject / abandonment sweeper. A partial unique index enforces
-- "at most one ACTIVE hold per Account" — the double-spend gate.

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

-- Double-spend gate: only one ACTIVE hold per Account at a time.
CREATE UNIQUE INDEX holds_one_active_per_account
  ON holds (account_hash, bank_pubkey)
  WHERE active;

CREATE INDEX holds_active_by_bank ON holds (bank_pubkey, active, created_at);

COMMENT ON TABLE holds IS 'Per-(account, deal) hold record. Partial unique index enforces single-active-hold-per-account: concurrent hold attempts surface as -32003 / deferred advance.';

-- ─────────────────────────────────────────────────────────────────────────
-- subscriptions + subscription_watches: signature fan-out
-- ─────────────────────────────────────────────────────────────────────────
--
-- The initiating party sends Subscription docs to banks; banks use them to
-- fan out the Signature docs they create (POST a bank-signed
-- notify_signatures envelope to `url`, fire-and-forget). Subscribers may be
-- users or peer banks — the topology is the client's choice.

CREATE TABLE subscriptions (
  subscription_hash  TEXT NOT NULL,    -- hash of the Subscription doc
  bank_pubkey        TEXT NOT NULL,
  subscriber_pubkey  TEXT NOT NULL,    -- Subscription.pubkey
  url                TEXT NOT NULL,
  until              TIMESTAMPTZ,      -- NULL = bank default applies in code
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

COMMENT ON TABLE subscriptions IS 'Standing fan-out targets. When the bank creates a Signature whose record/hash/deal matches a watch key, it POSTs the signature to url (fire-and-forget; client relay is the fallback).';

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
-- bank_peers: known peer banks (pubkey → URL)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Populated when a peer first contacts us or when a Subscription names a
-- peer bank. Read when fanning signatures out to peer banks.

CREATE TABLE bank_peers (
  bank_pubkey  TEXT NOT NULL,  -- the bank doing the bookkeeping
  peer_pubkey  TEXT NOT NULL,  -- the peer we know about
  peer_url     TEXT NOT NULL,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_pubkey, peer_pubkey)
);

CREATE INDEX bank_peers_by_bank ON bank_peers (bank_pubkey, last_seen DESC);

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

CREATE TRIGGER deal_legs_touch_updated_at
  BEFORE UPDATE ON deal_legs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
