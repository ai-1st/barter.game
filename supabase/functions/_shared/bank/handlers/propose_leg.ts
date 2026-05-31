// propose_leg — proposing client (a user) → each participating bank.
//
// The client built the whole deal (records + Tx) and now hands THIS bank only
// the slice it is allowed to see: the Tx (whose `records[]` is the full list of
// record HASHES) plus the BODIES of only this bank's own records (records whose
// `pubkey` is this bank — i.e. transfers of the promises this bank issues).
//
// The bank cannot see any other leg's amount/account/holder/promise; it just
// verifies its own records hash into the Tx, persists them, records its role +
// predecessors for the settle cascade, and signs an `approve`. See PROTOCOL.md
// §2 (Visibility) and §7.1 (Orchestration).

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { validateRecord, validateTx } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type ProposeLegParams = {
  tx: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  proposer_approve: Record<string, unknown>;
  role: "lead" | "follow";
  predecessors: string[];
};

export const proposeLeg: Handler = async (params, ctx) => {
  const p = params as ProposeLegParams;
  if (!p.tx || !Array.isArray(p.records)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx and params.records[] required");
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

  // Validate every record the client handed us: it must be well-formed, owned
  // by THIS bank, hash into the Tx, and name an account this bank knows.
  if (p.records.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "this bank owns no records in the deal");
  }
  for (const rec of p.records) {
    try {
      validateRecord(rec);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "record invalid");
    }
    if (rec.pubkey !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `record.pubkey ${String(rec.pubkey)} is not this bank`);
    }
    const recHash = hashDoc(rec);
    if (!txRecords.includes(recHash)) {
      throw new RpcError(RpcErrors.VALIDATION, `record ${recHash} is not in tx.records[]`);
    }
    const acct = await ctx.db.getAccount(rec.account as string);
    if (!acct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${String(rec.account)} not known to this bank`);
    }
  }

  // Persist the Tx (hash list), our own records, and the proposer's approve.
  await ctx.db.insertDoc({ hash: txHash, type: "tx", pubkey: proposerPubkey, body: p.tx });
  for (const rec of p.records) {
    await ctx.db.insertDoc({
      hash: hashDoc(rec),
      type: rec.type as string,
      pubkey: ctx.bankPubkey,
      body: rec,
    });
  }
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

  return { tx_hash: txHash, role: p.role, predecessors, approve, owned_records: p.records.length };
};
