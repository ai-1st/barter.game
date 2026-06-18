// Advance engine — banks self-advance through hold and settle per record pair.
//
// There is no client settle command. advanceRecord() is evaluated after every
// event that can unblock a record pair (a ready signature issued by submit_tx,
// or a peer signature arriving via notify_signatures) and moves the pair as far
// as it can:
//
//   ready → hold     both records ready, debit account has sufficient free
//                    balance; lock the account and sign hold on both records.
//   hold  → settle   both records held; apply deltas, release holds, sign
//                    settle on both records. `seen` contains any upstream
//                    settle signatures this bank has stored (v1 simpler rule).
//
// If any record in a pair is reject, the other record is also rejected and any
// hold on its debit account is released.
//
// Blocked conditions (hold conflict, missing pair record) return quietly —
// the next event retries. Authority never comes from the caller.

import { hashDoc, newUlid, signDoc } from "../../packages/protocol/src/index.ts";
import type { RpcContext } from "./rpc.ts";
import { fanoutSignatures } from "./subscriptions.ts";

export async function advanceRecord(recordHash: string, txHash: string, ctx: RpcContext): Promise<void> {
  const row = await ctx.db.getRecord(recordHash);
  if (!row) return;

  const pairRows = await ctx.db.getRecordsByPair(row.pair_ulid);
  if (pairRows.length !== 2) return; // wait for the peer record to exist

  const statuses = new Set(pairRows.map((r) => r.status));

  // Reject propagation: if any record is reject, reject the other.
  if (statuses.has("reject")) {
    for (const r of pairRows) {
      if (r.status !== "reject") {
        await rejectRecord(r.hash, "peer record rejected", ctx);
      }
    }
    return;
  }

  // Hold when both records are ready.
  if (statuses.has("ready") && !statuses.has("hold") && !statuses.has("settle")) {
    await tryHoldPair(pairRows, txHash, ctx);
  }

  // Settle when both records are held.
  const after = await ctx.db.getRecordsByPair(row.pair_ulid);
  const afterStatuses = new Set(after.map((r) => r.status));
  if (afterStatuses.has("hold") && !afterStatuses.has("settle")) {
    await trySettlePair(after, ctx);
  }
}

async function tryHoldPair(
  pairRows: Array<{ hash: string; status: string; type: string; account: string; amount: string; pair_ulid: string; body: Record<string, unknown> }>,
  txHash: string,
  ctx: RpcContext,
): Promise<void> {
  if (pairRows.some((r) => r.status !== "ready")) return;

  const debitRecord = pairRows.find((r) => r.type === "debit");
  const creditRecord = pairRows.find((r) => r.type === "credit");
  if (!debitRecord || !creditRecord) return;

  const amount = Number(debitRecord.amount);
  const ok = await ctx.db.acquireHold({
    accountHash: debitRecord.account,
    recordHash: debitRecord.hash,
    txHash,
    amount,
  });
  if (!ok) return; // hold conflict — retried on next event

  // Also acquire hold for the credit record's account if it is also a debit
  // elsewhere in the same tx. For a simple pair the credit account is not
  // debited, so this is a no-op unless the same account appears as debit in
  // another record of the same tx (handled by acquireHold).

  const holdSigs: Array<Record<string, unknown>> = [];
  for (const r of pairRows) {
    await ctx.db.moveRecord(r.hash, "ready", "hold");
    const sig: Record<string, unknown> = {
      type: "signature",
      pubkey: ctx.bankPubkey,
      ulid: newUlid(),
      hash: r.hash,
      action: "hold",
    };
    sig.sig = signDoc(sig, ctx.bankPrivateKey);
    await ctx.db.insertDoc({ hash: hashDoc(sig), type: "signature", pubkey: ctx.bankPubkey, body: sig });
    holdSigs.push(sig);
  }
  await fanoutSignatures(ctx, holdSigs);
}

async function trySettlePair(
  pairRows: Array<{ hash: string; status: string; type: string; account: string; amount: string; pair_ulid: string; body: Record<string, unknown> }>,
  ctx: RpcContext,
): Promise<void> {
  if (pairRows.some((r) => r.status !== "hold")) return;

  // Apply deltas and release holds.
  for (const r of pairRows) {
    const delta = r.type === "debit" ? -Number(r.amount) : +Number(r.amount);
    await ctx.db.applyBalanceDelta(r.account, delta);
    await ctx.db.releaseHold(r.account, r.hash);
    await ctx.db.moveRecord(r.hash, "hold", "settle");
  }

  // v1 simpler rule: cite all upstream settle signatures this bank has stored.
  const peerSettles = await ctx.db.listSettleSigs();
  const seen = peerSettles.map((s) => hashDoc(s));

  const settleSigs: Array<Record<string, unknown>> = [];
  for (const r of pairRows) {
    const sig: Record<string, unknown> = {
      type: "signature",
      pubkey: ctx.bankPubkey,
      ulid: newUlid(),
      hash: r.hash,
      action: "settle",
    };
    if (seen.length > 0) sig.seen = seen;
    sig.sig = signDoc(sig, ctx.bankPrivateKey);
    await ctx.db.insertDoc({ hash: hashDoc(sig), type: "signature", pubkey: ctx.bankPubkey, body: sig });
    settleSigs.push(sig);
  }
  await fanoutSignatures(ctx, settleSigs);
}

/** Reject a record and release any associated hold. */
export async function rejectRecord(
  recordHash: string,
  reason: string,
  ctx: RpcContext,
): Promise<Record<string, unknown> | null> {
  const row = await ctx.db.getRecord(recordHash);
  if (!row) return null;
  if (row.status === "settle") {
    throw new Error("cannot reject a settled record");
  }
  if (row.status === "reject") {
    const existing = await ctx.db.findActionSig(ctx.bankPubkey, recordHash, "reject");
    return existing;
  }

  await ctx.db.releaseHold(row.account, recordHash);
  await ctx.db.moveRecord(recordHash, row.status, "reject");

  const sig: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: recordHash,
    action: "reject",
  };
  sig.reason = reason;
  sig.sig = signDoc(sig, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(sig), type: "signature", pubkey: ctx.bankPubkey, body: sig });
  return sig;
}
