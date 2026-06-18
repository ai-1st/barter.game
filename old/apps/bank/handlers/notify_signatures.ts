// notify_signatures — a peer bank's fan-out push, or any party relaying.
//
// Signatures carry their own authority (signer pubkey + ed25519 sig over
// the doc), so the bank accepts them from anyone: a peer bank pushing per a
// Subscription, or a client relaying after a lost push. Each valid
// signature is stored, then every record hash it references is advanced.

import { hashDoc, verifyDoc, validateSignature } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { advanceRecord } from "../advance.ts";

type NotifySignaturesParams = { signatures: Array<Record<string, unknown>> };

export const notifySignatures: Handler = async (params, ctx) => {
  const p = params as NotifySignaturesParams;
  if (!Array.isArray(p.signatures) || p.signatures.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.signatures must be a non-empty array");
  }

  const stored: string[] = [];

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

    // A peer settle/reject signature may unblock a record pair we own.
    // Ready/hold peer signatures do not advance local records; the local
    // submit_tx provides the Tx hash needed to acquire holds.
    if (typeof s.hash === "string" && (s.action === "settle" || s.action === "reject")) {
      const row = await ctx.db.getRecord(s.hash);
      if (row && row.body.pubkey === ctx.bankPubkey) {
        await advanceRecord(s.hash, "", ctx);
      }
    }
  }

  return { stored: stored.length };
};
