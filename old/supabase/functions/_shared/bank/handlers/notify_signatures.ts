// notify_signatures — a peer bank's fan-out push, or any party relaying.
//
// Signatures carry their own authority (signer pubkey + ed25519 sig over
// the doc), so the bank accepts them from anyone: a peer bank pushing per a
// Subscription, or a client relaying after a lost push. Each valid
// signature is stored, then every deal it touches is advanced — this is the
// event that un-blocks waiting legs (a lead bank waiting on peer holds, a
// follow bank waiting on predecessor settles).

import { hashDoc, verifyDoc } from "../../protocol/crypto.ts";
import { validateSignature } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { advanceDeal } from "../advance.ts";

type NotifySignaturesParams = { signatures: Array<Record<string, unknown>> };

export const notifySignatures: Handler = async (params, ctx) => {
  const p = params as NotifySignaturesParams;
  if (!Array.isArray(p.signatures) || p.signatures.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.signatures must be a non-empty array");
  }

  const stored: string[] = [];
  const dealsTouched = new Set<string>();

  for (const s of p.signatures) {
    try {
      validateSignature(s);
    } catch {
      continue; // skip malformed entries; store what verifies
    }
    if (typeof s.sig !== "string" || typeof s.pubkey !== "string") continue;
    if (!verifyDoc(s, s.sig as string, s.pubkey as string)) continue;

    const hash = hashDoc(s);
    await ctx.db.insertDoc({ hash, type: "signature", pubkey: s.pubkey as string, body: s });
    stored.push(hash);
    if (typeof s.deal === "string") dealsTouched.add(s.deal as string);
  }

  // A new peer signature may unblock a leg — evaluate each touched deal.
  for (const deal of dealsTouched) {
    await advanceDeal(deal, ctx);
  }

  return { stored: stored.length, deals_advanced: [...dealsTouched] };
};
