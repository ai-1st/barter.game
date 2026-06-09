// settle_leg — proposing client → each bank, in topological order.
//
// The client drives the settle cascade. A lead bank settles first with no
// upstream sigs; each follower is called only once the client holds a valid
// `settle` signature from every one of the follower's predecessor banks, which
// it passes in as `upstream_settles`. The bank verifies those predecessor sigs
// (the lead/follow proof, PROTOCOL.md §2), applies its own deltas, releases its
// holds, and signs its own `settle` with `seen` = the upstream sigs — extending
// the verifiable chain. Re-calling on an already-settled leg is a no-op.

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type SettleLegParams = {
  tx_hash: string;
  upstream_settles?: Array<Record<string, unknown>>;
};

export const settleLeg: Handler = async (params, ctx) => {
  const p = params as SettleLegParams;
  if (typeof p.tx_hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash required");
  }
  const upstream = Array.isArray(p.upstream_settles) ? p.upstream_settles : [];

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);

  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (!txRow) throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx body missing`);
  if ((txRow.body as { pubkey: string }).pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "settle_leg caller must be the Tx proposer");
  }

  // Idempotent: if already settled, return the existing settle without
  // re-applying balances (re-applying would double-spend).
  if (txState.state === "settled") {
    const existing = await ctx.db.findActionSig(ctx.bankPubkey, p.tx_hash, "settle");
    return { tx_hash: p.tx_hash, state: "settled", settle: existing, applied: [], already: true };
  }
  if (txState.state !== "confirmed") {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `tx must be 'confirmed' to settle; got '${txState.state}' (not all holders on this leg confirmed)`,
    );
  }

  // Verify a valid predecessor `settle` is present for each predecessor bank.
  const settleByBank = new Map<string, Record<string, unknown>>();
  for (const s of upstream) {
    if (
      s &&
      typeof s.sig === "string" &&
      s.hash === p.tx_hash &&
      s.action === "settle" &&
      typeof s.pubkey === "string" &&
      verifyDoc(s, s.sig as string, s.pubkey as string)
    ) {
      settleByBank.set(s.pubkey as string, s);
    }
  }
  const seen: string[] = [];
  for (const pred of txState.predecessors) {
    const s = settleByBank.get(pred);
    if (!s) {
      throw new RpcError(
        RpcErrors.VALIDATION,
        `missing or invalid upstream settle from predecessor bank ${pred}`,
      );
    }
    await ctx.db.insertDoc({ hash: hashDoc(s), type: "signature", pubkey: pred, body: s });
    seen.push(hashDoc(s));
  }

  // Apply deltas for owned records; release holds on debited accounts.
  const recordUlids = (txRow.body as { records: string[] }).records;
  const recordRows = await ctx.db.getLedgerRecordsByUlids(recordUlids);
  const applied: Array<{ accountHash: string; delta: number; newBalance: string }> = [];
  for (const u of recordUlids) {
    const rec = recordRows[u];
    if (!rec || rec.pubkey !== ctx.bankPubkey) continue;
    const delta = rec.type === "debit" ? -(rec.amount as number) : +(rec.amount as number);
    const newBalance = await ctx.db.applyBalanceDelta(rec.account as string, delta);
    applied.push({ accountHash: rec.account as string, delta, newBalance });
  }
  for (const a of applied) {
    if (a.delta < 0) await ctx.db.releaseHold(a.accountHash, p.tx_hash);
  }

  // Sign this bank's settle, citing the upstream sigs it saw.
  const settle: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "settle",
  };
  if (seen.length > 0) settle.seen = seen;
  settle.sig = signDoc(settle, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(settle), type: "signature", pubkey: ctx.bankPubkey, body: settle });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "settled" });

  return { tx_hash: p.tx_hash, state: "settled", settle, applied };
};
