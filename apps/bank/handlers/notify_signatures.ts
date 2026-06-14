// notify_signatures — a peer bank's fan-out push, or any party relaying.
//
// Signatures carry their own authority (signer pubkey + ed25519 sig over
// the doc), so the bank accepts them from anyone: a peer bank pushing per a
// Subscription, or a client relaying after a lost push. Each valid
// signature is stored, then every session it touches — plus every local
// session still in play — is advanced. A peer's hold/settle targets the
// peer's own session, so the receiving bank must also re-evaluate its own
// pending sessions when such signatures arrive.

import { hashDoc, verifyDoc, validateSignature } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { advanceSession } from "../advance.ts";

type NotifySignaturesParams = { signatures: Array<Record<string, unknown>> };

export const notifySignatures: Handler = async (params, ctx) => {
  const p = params as NotifySignaturesParams;
  if (!Array.isArray(p.signatures) || p.signatures.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.signatures must be a non-empty array");
  }

  const stored: string[] = [];
  const sessionsTouched = new Set<string>();

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
    if (typeof s.session === "string") sessionsTouched.add(s.session as string);
  }

  // A new peer signature may unblock one of our sessions: peer holds/settles
  // target the peer's session, not ours, so we also re-evaluate every local
  // non-terminal session. advanceSession is idempotent and no-ops if nothing
  // changed.
  const localSessions = await ctx.db.listPendingSessions();

  for (const session of new Set([...sessionsTouched, ...localSessions])) {
    await advanceSession(session, ctx);
  }

  return { stored: stored.length, sessions_advanced: [...new Set([...sessionsTouched, ...localSessions])] };
};
