// Advance engine — banks self-advance through hold and settle.
//
// There is no client settle command. advanceDeal() is evaluated after every
// event that can unblock a leg (submit_tx completing approval, a signature
// arriving via notify_signatures) and moves the leg as far as it can:
//
//   approved → held     lock owned debit accounts, sign {deal, hold}, fan out
//   held     → settled  lead: once hold signatures from every other bank in
//                        the deal have been observed (it settles first,
//                        bearing the lead/follow risk);
//                       follow: once verified {deal, settle} signatures from
//                        all predecessor banks are stored — their hashes go
//                        into this bank's settle Signature.seen, extending
//                        the verifiable proof chain.
//
// Blocked conditions (hold conflict, missing peer signatures) return quietly
// — the next event retries. Authority never comes from the caller: holds
// require the leg to be `approved` (every owned record bound to a
// holder-signed Tx and bank-approved), and settles require stored, verified
// peer signatures.

import { hashDoc, newUlid, signDoc } from "../protocol/crypto.ts";
import type { RpcContext } from "./rpc.ts";
import { fanoutSignatures } from "./subscriptions.ts";

export async function advanceDeal(deal: string, ctx: RpcContext): Promise<void> {
  let leg = await ctx.db.getLegState(deal);
  if (!leg) return;

  if (leg.state === "approved") {
    const held = await tryHold(deal, ctx);
    if (!held) return; // hold conflict — retried on the next event
    // Fan-out inside tryHold can re-enter advanceDeal (a peer's push may
    // arrive synchronously in-process); re-read instead of trusting the
    // local copy, or a nested settle would be applied twice.
    leg = await ctx.db.getLegState(deal);
    if (!leg) return;
  }

  if (leg.state === "held") {
    await trySettle(deal, ctx, leg.role, leg.predecessors, leg.banks);
  }
}

/** Lock owned debit accounts and sign the hold. Returns false on conflict. */
async function tryHold(deal: string, ctx: RpcContext): Promise<boolean> {
  const records = await ctx.db.getLedgerRecordsByDeal(deal);

  // One account may be debited by several records in the same deal; the hold
  // is per-account, so dedupe and sum.
  const amountByAccount = new Map<string, number>();
  for (const rec of records) {
    if (rec.type !== "debit") continue;
    amountByAccount.set(rec.account, (amountByAccount.get(rec.account) ?? 0) + Number(rec.amount));
  }

  const acquired: string[] = [];
  for (const [accountHash, amount] of amountByAccount) {
    const ok = await ctx.db.acquireHold({ accountHash, dealUlid: deal, amount });
    if (!ok) {
      // Another deal holds this account. Back off; release what we took so
      // the competing deal isn't blocked by a half-acquired set.
      for (const a of acquired) await ctx.db.releaseHold(a, deal);
      return false;
    }
    acquired.push(accountHash);
  }

  const hold: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    deal,
    action: "hold",
  };
  hold.sig = signDoc(hold, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(hold), type: "signature", pubkey: ctx.bankPubkey, body: hold });
  await ctx.db.upsertLeg({ dealUlid: deal, state: "held" });
  await fanoutSignatures(ctx, [hold]);
  return true;
}

/** Settle if the lead/follow precondition is met. */
async function trySettle(
  deal: string,
  ctx: RpcContext,
  role: string | null,
  predecessors: string[],
  banks: string[],
): Promise<void> {
  const seen: string[] = [];

  if (role === "follow") {
    // Wait for a stored, verified settle from every predecessor bank.
    // (notify_signatures verifies before storing.)
    for (const pred of predecessors) {
      const s = await ctx.db.findActionSig(pred, { deal }, "settle");
      if (!s) return; // not yet — retried on the next event
      seen.push(hashDoc(s));
    }
  } else {
    // Lead settles first — but only once every other bank in the deal has
    // locked its side, so nothing downstream can be double-spent away.
    for (const bank of banks) {
      if (bank === ctx.bankPubkey) continue;
      const h = await ctx.db.findActionSig(bank, { deal }, "hold");
      if (!h) return; // not yet
    }
  }

  // The waits above (and their own fan-outs) may have settled this leg via
  // a re-entrant advance — settling is idempotent-by-state, never by replay.
  const fresh = await ctx.db.getLegState(deal);
  if (!fresh || fresh.state !== "held") return;

  // Apply deltas for every owned record, release holds on debited accounts.
  const records = await ctx.db.getLedgerRecordsByDeal(deal);
  for (const rec of records) {
    const delta = rec.type === "debit" ? -Number(rec.amount) : +Number(rec.amount);
    await ctx.db.applyBalanceDelta(rec.account, delta);
  }
  await ctx.db.releaseHoldsByDeal(deal);

  const settle: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    deal,
    action: "settle",
  };
  if (seen.length > 0) settle.seen = seen;
  settle.sig = signDoc(settle, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(settle), type: "signature", pubkey: ctx.bankPubkey, body: settle });
  await ctx.db.upsertLeg({ dealUlid: deal, state: "settled" });
  await fanoutSignatures(ctx, [settle]);
}
