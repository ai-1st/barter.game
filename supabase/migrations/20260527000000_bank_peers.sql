-- bank_peers: each bank stores known peer banks (pubkey → URL).
-- Populated when a peer first contacts us (via approve_trade etc).
-- Read when we need to call them back (via forward_confirm, notify_settle).

CREATE TABLE bank_peers (
  bank_pubkey  TEXT NOT NULL,  -- the bank doing the bookkeeping
  peer_pubkey  TEXT NOT NULL,  -- the peer we know about
  peer_url     TEXT NOT NULL,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_pubkey, peer_pubkey)
);

CREATE INDEX bank_peers_by_bank ON bank_peers (bank_pubkey, last_seen DESC);
