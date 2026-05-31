// reject_leg — proposing client → each bank, to abort a deal before settle.
//
// Releases any holds this bank acquired for the Tx and marks the leg rejected.
// Used when a hold conflict (or any pre-settle failure) forces the client to
// unwind. There is no rollback after a leg has settled (lead/follow risk, §2).

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type RejectLegParams = { tx_hash: string; reason?: string };

export const rejectLeg: Handler = async (params, ctx) => {
  const p = params as RejectLegParams;
  if (typeof p.tx_hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);
  }
  if (txState.state === "settled") {
    throw new RpcError(RpcErrors.VALIDATION, "cannot reject a settled leg (no rollback in v1)");
  }

  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (txRow) {
    if ((txRow.body as { pubkey: string }).pubkey !== ctx.senderPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, "reject_leg caller must be the Tx proposer");
    }
    const recordHashes = (txRow.body as { records: string[] }).records;
    const recordRows = await ctx.db.getDocsByHashes(recordHashes);
    for (const h of recordHashes) {
      const rec = recordRows[h];
      if (!rec || rec.pubkey !== ctx.bankPubkey || rec.type !== "debit") continue;
      await ctx.db.releaseHold(rec.account as string, p.tx_hash);
    }
  }

  const reject: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "reject",
  };
  if (p.reason) reject.reason = p.reason;
  reject.sig = signDoc(reject, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(reject), type: "signature", pubkey: ctx.bankPubkey, body: reject });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "rejected" });

  return { tx_hash: p.tx_hash, state: "rejected" };
};
