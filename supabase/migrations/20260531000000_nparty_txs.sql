-- N-party settlement: replace the bilateral lead/follow columns on `txs` with a
-- per-bank role + predecessor list. Under the client-orchestrated model
-- (PROTOCOL.md §2 Visibility, §7.1) each bank stores only its own role and the
-- set of predecessor banks whose `settle` it must observe before settling.
--
-- v1 migration policy is "wipe demo banks on schema change"; this ALTER is
-- written defensively (IF EXISTS / IF NOT EXISTS) so it is also safe to apply
-- to a fresh init_schema deployment.

ALTER TABLE txs DROP COLUMN IF EXISTS lead_bank_pubkey;
ALTER TABLE txs DROP COLUMN IF EXISTS follow_bank_pubkey;

ALTER TABLE txs ADD COLUMN IF NOT EXISTS role TEXT;                         -- 'lead' | 'follow'
ALTER TABLE txs ADD COLUMN IF NOT EXISTS predecessors JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN txs.role IS 'This bank''s role in the Tx: lead (settles first, bears the lead/follow risk) or follow.';
COMMENT ON COLUMN txs.predecessors IS 'JSON array of bank pubkeys whose settle this bank must observe (Signature.seen) before settling its own leg.';
