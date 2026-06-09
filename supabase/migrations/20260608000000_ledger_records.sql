-- Ledger records are bank-minted, ULID-identified, and NOT content-addressed.
-- The bank assigns ULIDs at creation time and ensures uniqueness. Records
-- reference each other (pair, tx) by ULID rather than by content hash.
-- This breaks the "everything is content-addressable" invariant for records
-- and Txs: two independent builds of the same logical deal produce different
-- ULIDs and therefore different Tx hashes.

CREATE TABLE ledger_records (
  ulid         TEXT NOT NULL,
  bank_pubkey  TEXT NOT NULL,
  type         TEXT NOT NULL,        -- credit | debit
  account      TEXT NOT NULL,        -- account hash (still content-addressed)
  amount       NUMERIC NOT NULL,
  pair_ulid    TEXT,                 -- peer record ULID (set at creation)
  tx_ulid      TEXT,                 -- containing Tx ULID (set at propose_leg)
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ulid, bank_pubkey)
);

CREATE INDEX ledger_records_by_account ON ledger_records (bank_pubkey, account);
CREATE INDEX ledger_records_by_tx ON ledger_records (bank_pubkey, tx_ulid);

COMMENT ON TABLE ledger_records IS 'Bank-minted ledger entries identified by ULID, not content hash. References between records and Txs use ULIDs.';
