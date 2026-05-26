// hold — lead bank → follow bank.
//
// Lead bank has already acquired its own hold on its side; it now asks the
// follow bank to acquire holds on the follow bank's owned debit account(s).
// If the follow bank can't acquire (concurrent hold conflict), it returns
// -32003 and the lead releases its own hold.

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type HoldParams = {
  tx_hash: string;
  lead_hold: Record<string, unknown>;
};

export const hold: Handler = async (params, ctx) => {
  const p = params as HoldParams;
  if (typeof p.tx_hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash required");
  }
  if (!p.lead_hold) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.lead_hold required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known to this bank`);
  }
  if (txState.state !== "approved") {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `tx state must be 'approved' to hold; got '${txState.state}'`,
    );
  }
  if (txState.lead_bank_pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, `hold caller must equal lead_bank_pubkey`);
  }

  // Verify lead's hold signature.
  if (
    typeof p.lead_hold.sig !== "string" ||
    p.lead_hold.pubkey !== txState.lead_bank_pubkey ||
    (p.lead_hold as Record<string, unknown>).hash !== p.tx_hash ||
    (p.lead_hold as Record<string, unknown>).action !== "hold" ||
    !verifyDoc(p.lead_hold, p.lead_hold.sig as string, txState.lead_bank_pubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "lead_hold signature invalid");
  }

  // Find this bank's debit account(s) for this Tx.
  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (!txRow) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx body ${p.tx_hash} missing`);
  }
  const recordHashes = (txRow.body as { records: string[] }).records;
  const recordRows = await ctx.db.getDocsByHashes(recordHashes);

  const debitAccounts: Array<{ accountHash: string; amount: number }> = [];
  for (const h of recordHashes) {
    const rec = recordRows[h];
    if (!rec) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `record ${h} missing on this bank`);
    }
    if (rec.pubkey === ctx.bankPubkey && rec.type === "debit") {
      debitAccounts.push({
        accountHash: rec.account as string,
        amount: rec.amount as number,
      });
    }
  }
  if (debitAccounts.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "no owned debit accounts on this bank");
  }

  // Acquire holds on each owned debit account. Roll back if any fails.
  const acquired: Array<{ accountHash: string }> = [];
  try {
    for (const da of debitAccounts) {
      const ok = await ctx.db.acquireHold({
        accountHash: da.accountHash,
        txHash: p.tx_hash,
        amount: da.amount,
      });
      if (!ok) {
        throw new RpcError(RpcErrors.LOCK_CONFLICT, `account ${da.accountHash} already held by another tx`);
      }
      acquired.push({ accountHash: da.accountHash });
    }
  } catch (err) {
    for (const a of acquired) {
      await ctx.db.releaseHold(a.accountHash, p.tx_hash);
    }
    throw err;
  }

  // Persist lead's hold sig + sign follow's own.
  await ctx.db.insertDoc({
    hash: hashDoc(p.lead_hold),
    type: "signature",
    pubkey: txState.lead_bank_pubkey,
    body: p.lead_hold,
  });

  const followHold: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "hold",
  };
  followHold.sig = signDoc(followHold, ctx.bankPrivateKey);
  await ctx.db.insertDoc({
    hash: hashDoc(followHold),
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: followHold,
  });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "held" });

  return { follow_hold: followHold };
};
