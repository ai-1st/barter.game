// Signature fan-out. When the bank creates a Signature doc, it pushes it to
// every active subscription watching one of the signature's anchor keys
// (record ULID, doc hash, deal ULID), as a bank-signed `notify_signatures`
// JSON-RPC envelope POSTed to the subscription's url.
//
// Fire-and-forget: a lost push never fails the originating request. Any
// party can relay the same signatures later (`notify_signatures` accepts
// them from anyone — the signatures carry their own authority), so the
// system converges even with flaky push delivery.

import { newUlid, signDoc } from "../protocol/crypto.ts";
import type { RpcContext } from "./rpc.ts";

const PUSH_TIMEOUT_MS = 4000;

/** The anchor keys a signature can be watched under. */
export function watchKeysForSig(sig: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const f of ["record", "hash", "deal"]) {
    if (typeof sig[f] === "string") keys.push(sig[f] as string);
  }
  return keys;
}

/** Push freshly created signatures to matching subscribers. Never throws. */
export async function fanoutSignatures(
  ctx: RpcContext,
  sigs: Array<Record<string, unknown>>,
): Promise<void> {
  try {
    const keys = [...new Set(sigs.flatMap(watchKeysForSig))];
    if (keys.length === 0) return;
    const subs = await ctx.db.findSubscriptionsByWatchKeys(keys);
    for (const sub of subs) {
      const envelope: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: newUlid(),
        method: "notify_signatures",
        params: { signatures: sigs },
        pubkey: ctx.bankPubkey,
        to: sub.subscriber_pubkey,
      };
      envelope.sig = signDoc(envelope, ctx.bankPrivateKey);
      try {
        await fetch(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
      } catch {
        // fire-and-forget — relay is the recovery path
      }
    }
  } catch {
    // fan-out must never fail the originating request
  }
}
