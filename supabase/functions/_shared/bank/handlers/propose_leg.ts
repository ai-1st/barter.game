// propose_leg — proposing client (a user) → each participating bank.
//
// The client has already called create_records on every bank and now hands
// THIS bank the assembled Tx (whose records[] is the full list of record ULIDs)
// plus the ULIDs of this bank's own records. The bank verifies those ULIDs
// were created by it, checks they appear in tx.records, persists the Tx,
// binds the records to the Tx, records its role + predecessors, and signs
// an `approve`. See PROTOCOL.md §2 (Visibility) and §7.1 (Orchestration).

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { validateTx } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type ProposeLegParams = {
  tx: Record<string, unknown>;
  record_ulids: string[];
  proposer_approve: Record<string, unknown>;
  role: "lead" | "follow";
  predecessors: string[];
};

export const proposeLeg: Handler = async (params, ctx) => {
  const p = params as ProposeLegParams;
  if (!p.tx || !Array.isArray(p.record_ulids)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx and params.record_ulids[] required");
  }
  if (p.role !== "lead" && p.role !== "follow") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.role must be 'lead' or 'follow'");
  }
  const predecessors = Array.isArray(p.predecessors) ? p.predecessors : [];
  for (const pre of predecessors) {
    if (typeof pre !== "string" || pre.length === 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "params.predecessors[] must be bank pubkeys");
    }
  }

  try {
    validateTx(p.tx);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "tx invalid");
  }
  const txHash = hashDoc(p.tx);
  const txRecords = (p.tx as { records: string[] }).records;
  const txUlid = (p.tx as { ulid: string }).ulid;
  const proposerPubkey = (p.tx as { pubkey: string }).pubkey;

  // The proposer (Tx author) is the calling user and must have signed approve.
  if (ctx.senderPubkey !== proposerPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "propose_leg caller must be the Tx proposer (tx.pubkey)");
  }
  const pa = p.proposer_approve as Record<string, unknown> | undefined;
  if (
    !pa ||
    pa.pubkey !== proposerPubkey ||
    pa.hash !== txHash ||
    pa.action !== "approve" ||
    typeof pa.sig !== "string" ||
    !verifyDoc(pa, pa.sig as string, proposerPubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "proposer_approve signature invalid for this tx");
  }

  // Validate every record ULID the client claims is ours.
  if (p.record_ulids.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "this bank owns no records in the deal");
  }
  const recordBodies = await ctx.db.getLedgerRecordsByUlids(p.record_ulids);
  for (const ulid of p.record_ulids) {
    const rec = recordBodies[ulid];
    if (!rec) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `record ULID ${ulid} not found at this bank`);
    }
    if (rec.pubkey !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `record ${ulid} is not owned by this bank`);
    }
    if (!txRecords.includes(ulid)) {
      throw new RpcError(RpcErrors.VALIDATION, `record ULID ${ulid} is not in tx.records[]`);
    }
    const acct = await ctx.db.getAccount(rec.account as string);
    if (!acct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${String(rec.account)} not known to this bank`);
    }
  }

  // Persist the Tx (hash list), bind our records to it, and store proposer approve.
  await ctx.db.insertDoc({ hash: txHash, type: "tx", pubkey: proposerPubkey, body: p.tx });
  await ctx.db.bindRecordsToTx(p.record_ulids, txUlid);
  await ctx.db.insertDoc({
    hash: hashDoc(pa),
    type: "signature",
    pubkey: proposerPubkey,
    body: pa,
  });
  await ctx.db.upsertTx({ txHash, state: "approved", role: p.role, predecessors });

  // Sign this bank's approve and return it for the client to collect.
  const approve: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "approve",
  };
  approve.sig = signDoc(approve, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(approve), type: "signature", pubkey: ctx.bankPubkey, body: approve });

  return { tx_hash: txHash, role: p.role, predecessors, approve, owned_records: p.record_ulids.length };
};
