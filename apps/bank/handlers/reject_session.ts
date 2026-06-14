// reject_session — a session participant → each bank, to abort before settle.
//
// Releases any holds this bank acquired for the session and marks the leg
// rejected. The reject signature fans out to subscribers so observers learn
// the session died; in v0 the rejecting party calls reject_session on every
// participating bank to unwind all legs. There is no rollback after a leg has
// settled (lead/follow risk, PROTOCOL.md §2).

import { hashDoc, newUlid, signDoc } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { fanoutSignatures } from "../subscriptions.ts";

type RejectSessionParams = { session: string; reason?: string };

export const rejectSession: Handler = async (params, ctx) => {
  const p = params as RejectSessionParams;
  if (typeof p.session !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.session required");
  }

  const leg = await ctx.db.getLegState(p.session);
  if (!leg) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `session ${p.session} not known to this bank`);
  }
  if (leg.state === "settled") {
    throw new RpcError(RpcErrors.VALIDATION, "cannot reject a settled leg (no rollback in v1)");
  }
  if (leg.state === "rejected") {
    return { session: p.session, state: "rejected", already: true };
  }

  // Caller must be a participant: a holder of one of the session's accounts.
  const records = await ctx.db.getRecordsBySession(p.session);
  let isParticipant = false;
  for (const rec of records) {
    const acct = await ctx.db.getAccount(rec.account);
    if (acct?.holder_pubkey === ctx.senderPubkey) {
      isParticipant = true;
      break;
    }
  }
  if (!isParticipant) {
    throw new RpcError(RpcErrors.VALIDATION, "reject_session caller must hold an account in the session");
  }

  await ctx.db.releaseHoldsBySession(p.session);

  const reject: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    session: p.session,
    action: "reject",
  };
  if (p.reason) reject.reason = p.reason;
  reject.sig = signDoc(reject, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(reject), type: "signature", pubkey: ctx.bankPubkey, body: reject });

  await ctx.db.upsertLeg({ session: p.session, state: "rejected" });
  await fanoutSignatures(ctx, [reject]);

  return { session: p.session, state: "rejected" };
};
