// Advance engine — banks self-advance through hold and settle.
//
// There is no client settle command. advanceSession() is evaluated after every
// event that can unblock a leg (submit_tx completing approval, a signature
// arriving via notify_signatures) and moves the leg as far as it can:
//
//   approved → held     lock owned debit accounts, sign {session, hold}, fan out
//   held     → settled  lead: once hold signatures from every other bank in
//                        the deal have been observed (it settles first,
//                        bearing the lead/follow risk);
//                       follow: once verified {session, settle} signatures from
//                        all predecessor banks are stored — their hashes go
//                        into this bank's settle Signature.seen, extending
//                        the verifiable proof chain.
//
// Blocked conditions (hold conflict, missing peer signatures) return quietly
// — the next event retries. Authority never comes from the caller: holds
// require the leg to be `approved` (every owned record bound to a
// holder-signed Tx and bank-approved), and settles require stored, verified
// peer signatures.

import { hashDoc, newUlid, signDoc } from "../../packages/protocol/src/index.ts";
import type { RpcContext } from "./rpc.ts";
import { fanoutSignatures } from "./subscriptions.ts";

export async function advanceSession(session: string, ctx: RpcContext): Promise<void> {
  let leg = await ctx.db.getLegState(session);
  if (!leg) return;

  if (leg.state === "approved") {
    const held = await tryHold(session, ctx);
    if (!held) return; // hold conflict — retried on the next event
    // Re-read to avoid double-advance if fan-out re-entered.
    leg = await ctx.db.getLegState(session);
    if (!leg) return;
  }

  if (leg.state === "held") {
    await trySettle(session, ctx, leg.role, leg.predecessors, leg.banks);
  }
}

/** Lock owned debit accounts and sign the hold. Returns false on conflict. */
async function tryHold(session: string, ctx: RpcContext): Promise<boolean> {
  const records = await ctx.db.getRecordsBySession(session);

  // One account may be debited by several records in the same session; the hold
  // is per-account, so dedupe and sum.
  const amountByAccount = new Map<string, number>();
  for (const rec of records) {
    if (rec.type !== "debit") continue;
    amountByAccount.set(rec.account, (amountByAccount.get(rec.account) ?? 0) + Number(rec.amount));
  }

  const acquired: string[] = [];
  for (const [accountHash, amount] of amountByAccount) {
    const ok = await ctx.db.acquireHold({ accountHash, session, amount });
    if (!ok) {
      // Another session holds this account. Back off; release what we took so
      // the competing session isn't blocked by a half-acquired set.
      for (const a of acquired) await ctx.db.releaseHold(a, session);
      return false;
    }
    acquired.push(accountHash);
  }

  const hold: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    session,
    action: "hold",
  };
  hold.sig = signDoc(hold, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(hold), type: "signature", pubkey: ctx.bankPubkey, body: hold });
  await ctx.db.upsertLeg({ session, state: "held" });
  await fanoutSignatures(ctx, [hold]);
  return true;
}

/** Settle if the lead/follow precondition is met. */
async function trySettle(
  session: string,
  ctx: RpcContext,
  role: string | null,
  predecessors: string[],
  banks: string[],
): Promise<void> {
  const seen: string[] = [];

  if (role === "follow") {
    // Wait for a stored, verified settle from every predecessor bank.
    // The predecessor's settle targets *its own* session, so we match by
    // signer pubkey and action only.
    for (const pred of predecessors) {
      const s = await ctx.db.findActionSig(pred, {}, "settle");
      if (!s) return; // not yet — retried on the next event
      seen.push(hashDoc(s));
    }
  } else {
    // Lead settles first — but only once every other bank in the deal has
    // locked its side, so the whole graph is locked before anyone moves.
    // Peer holds target the peer's own session; match by signer/action only.
    for (const bank of banks) {
      if (bank === ctx.bankPubkey) continue;
      const h = await ctx.db.findActionSig(bank, {}, "hold");
      if (!h) return; // not yet
    }
  }

  // Guard against re-entrant double settle.
  const fresh = await ctx.db.getLegState(session);
  if (!fresh || fresh.state !== "held") return;

  // Apply deltas for every owned record, release holds on debited accounts.
  const records = await ctx.db.getRecordsBySession(session);
  for (const rec of records) {
    const delta = rec.type === "debit" ? -Number(rec.amount) : +Number(rec.amount);
    await ctx.db.applyBalanceDelta(rec.account, delta);
  }
  await ctx.db.releaseHoldsBySession(session);

  const settle: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    session,
    action: "settle",
  };
  if (seen.length > 0) settle.seen = seen;
  settle.sig = signDoc(settle, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(settle), type: "signature", pubkey: ctx.bankPubkey, body: settle });
  await ctx.db.upsertLeg({ session, state: "settled" });
  await fanoutSignatures(ctx, [settle]);
}
