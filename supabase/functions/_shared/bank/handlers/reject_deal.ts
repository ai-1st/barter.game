// reject_deal — a deal participant → each bank, to abort before settle.
//
// Releases any holds this bank acquired for the deal and marks the leg
// rejected. The reject signature fans out to subscribers so observers learn
// the deal died; in v0 the rejecting party calls reject_deal on every bank
// in the deal to unwind all legs. There is no rollback after a leg has
// settled (lead/follow risk, PROTOCOL.md §2).

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { fanoutSignatures } from "../subscriptions.ts";

type RejectDealParams = { deal: string; reason?: string };

export const rejectDeal: Handler = async (params, ctx) => {
  const p = params as RejectDealParams;
  if (typeof p.deal !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.deal required");
  }

  const leg = await ctx.db.getLegState(p.deal);
  if (!leg) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `deal ${p.deal} not known to this bank`);
  }
  if (leg.state === "settled") {
    throw new RpcError(RpcErrors.VALIDATION, "cannot reject a settled leg (no rollback in v1)");
  }
  if (leg.state === "rejected") {
    return { deal: p.deal, state: "rejected", already: true };
  }

  // Caller must be a participant: a holder of one of the deal's accounts.
  const records = await ctx.db.getLedgerRecordsByDeal(p.deal);
  let isParticipant = false;
  for (const rec of records) {
    const acct = await ctx.db.getAccount(rec.account);
    if (acct?.holder_pubkey === ctx.senderPubkey) {
      isParticipant = true;
      break;
    }
  }
  if (!isParticipant) {
    throw new RpcError(RpcErrors.VALIDATION, "reject_deal caller must hold an account in the deal");
  }

  await ctx.db.releaseHoldsByDeal(p.deal);

  const reject: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    deal: p.deal,
    action: "reject",
  };
  if (p.reason) reject.reason = p.reason;
  reject.sig = signDoc(reject, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(reject), type: "signature", pubkey: ctx.bankPubkey, body: reject });

  await ctx.db.upsertLeg({ dealUlid: p.deal, state: "rejected" });
  await fanoutSignatures(ctx, [reject]);

  return { deal: p.deal, state: "rejected" };
};
