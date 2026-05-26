// settle — user (lead user) → lead bank.
//
// Triggered by Alice after both confirm_receipts are seen on the lead bank
// (state == confirmed). Lead bank:
//   1. Applies balance deltas for its owned records (debit sender, credit peer).
//   2. Releases its holds.
//   3. Signs a settle Signature.
//   4. Calls notify_settle on the follow bank with the signed doc.
//   5. Returns success once follow has acked.
//
// Lead/follow risk: between step 3 and step 5, lead has committed money but
// follow has not. If follow refuses notify_settle, lead's money is gone and
// the trade is half-done. v1 accepts this risk (Risk Model section of the
// design doc).

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { callPeer } from "../peer.ts";

type SettleParams = { tx_hash: string };

export const settle: Handler = async (params, ctx) => {
  const p = params as SettleParams;
  if (typeof p.tx_hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);
  }
  if (txState.lead_bank_pubkey !== ctx.bankPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "settle can only run on the lead bank");
  }
  if (txState.state !== "confirmed") {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `tx must be 'confirmed' to settle; got '${txState.state}'`,
    );
  }

  // Apply balance deltas for owned records.
  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (!txRow) throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx body missing`);
  const txBody = txRow.body as { records: string[]; pubkey: string };
  const recordRows = await ctx.db.getDocsByHashes(txBody.records);

  const applied: Array<{ accountHash: string; delta: number; newBalance: string }> = [];
  for (const h of txBody.records) {
    const rec = recordRows[h];
    if (!rec) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `record ${h} missing`);
    }
    if (rec.pubkey !== ctx.bankPubkey) continue;
    const delta = rec.type === "debit" ? -(rec.amount as number) : +(rec.amount as number);
    const newBalance = await ctx.db.applyBalanceDelta(rec.account as string, delta);
    applied.push({ accountHash: rec.account as string, delta, newBalance });
  }

  // Release lead's holds.
  for (const a of applied) {
    if (a.delta < 0) {
      await ctx.db.releaseHold(a.accountHash, p.tx_hash);
    }
  }

  // Sign lead's settle.
  const leadSettle: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "settle",
  };
  leadSettle.sig = signDoc(leadSettle, ctx.bankPrivateKey);
  await ctx.db.insertDoc({
    hash: hashDoc(leadSettle),
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: leadSettle,
  });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "settled" });

  // Notify follow bank. v1 accepts that if this call fails, lead has
  // already moved its balances — that's the lead/follow risk.
  if (
    txState.follow_bank_pubkey &&
    txState.follow_bank_pubkey !== ctx.bankPubkey
  ) {
    const followUrl = await ctx.db.lookupPeerUrl(txState.follow_bank_pubkey);
    if (!followUrl) {
      throw new RpcError(
        RpcErrors.INTERNAL,
        `follow bank URL not known; settle succeeded locally but cannot notify peer`,
      );
    }
    const result = await callPeer({
      bankUrl: followUrl,
      bankPubkey: ctx.bankPubkey,
      bankPrivateKey: ctx.bankPrivateKey,
      peerPubkey: txState.follow_bank_pubkey,
      method: "notify_settle",
      params: {
        tx_hash: p.tx_hash,
        lead_settle: leadSettle,
      },
    });
    if (result.error) {
      // v1: leave the Tx as settled on lead side. Document the failure;
      // recovery is a v1.5 problem.
      return {
        tx_hash: p.tx_hash,
        state: "settled-lead-only",
        applied,
        lead_settle: leadSettle,
        notify_error: result.error,
        warning:
          "lead settled but notify_settle to follow bank failed. " +
          "Lead party may be out per the lead/follow risk model.",
      };
    }
  }

  return {
    tx_hash: p.tx_hash,
    state: "settled",
    applied,
    lead_settle: leadSettle,
  };
};

/**
 * notify_settle — lead bank → follow bank.
 * Follow bank verifies the lead's settle sig, applies its own balance
 * deltas for owned records, releases its holds, signs follow_settle.
 */
type NotifySettleParams = {
  tx_hash: string;
  lead_settle: Record<string, unknown>;
};

export const notifySettle: Handler = async (params, ctx) => {
  const p = params as NotifySettleParams;
  if (typeof p.tx_hash !== "string" || !p.lead_settle) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash and params.lead_settle required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);
  }
  if (txState.lead_bank_pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "notify_settle caller must equal lead_bank_pubkey");
  }

  // Validate lead_settle sig.
  const ls = p.lead_settle as Record<string, unknown>;
  const { verifyDoc } = await import("../../protocol/crypto.ts");
  if (
    typeof ls.sig !== "string" ||
    ls.pubkey !== txState.lead_bank_pubkey ||
    ls.hash !== p.tx_hash ||
    ls.action !== "settle" ||
    !verifyDoc(ls, ls.sig as string, txState.lead_bank_pubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "lead_settle signature invalid");
  }

  // Apply own balance deltas + release holds.
  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (!txRow) throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx body missing`);
  const recordHashes = (txRow.body as { records: string[] }).records;
  const recordRows = await ctx.db.getDocsByHashes(recordHashes);

  const applied: Array<{ accountHash: string; delta: number; newBalance: string }> = [];
  for (const h of recordHashes) {
    const rec = recordRows[h];
    if (!rec) continue;
    if (rec.pubkey !== ctx.bankPubkey) continue;
    const delta = rec.type === "debit" ? -(rec.amount as number) : +(rec.amount as number);
    const newBalance = await ctx.db.applyBalanceDelta(rec.account as string, delta);
    applied.push({ accountHash: rec.account as string, delta, newBalance });
  }
  for (const a of applied) {
    if (a.delta < 0) await ctx.db.releaseHold(a.accountHash, p.tx_hash);
  }

  await ctx.db.insertDoc({
    hash: hashDoc(ls),
    type: "signature",
    pubkey: txState.lead_bank_pubkey,
    body: ls,
  });

  const followSettle: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "settle",
  };
  followSettle.sig = signDoc(followSettle, ctx.bankPrivateKey);
  await ctx.db.insertDoc({
    hash: hashDoc(followSettle),
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: followSettle,
  });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "settled" });

  return { follow_settle: followSettle, applied };
};
