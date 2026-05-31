// confirm_receipt — a holder → each bank where they hold a record in the Tx.
//
// The holder signs a settle-action Signature over the Tx hash ("I confirm
// receipt; you may settle"). The client delivers that one signature to every
// bank the holder touches (it cannot be forwarded bank-to-bank — banks don't
// see each other's legs). A bank's leg becomes `confirmed` once EVERY holder
// appearing in that bank's own records has signed. See PROTOCOL.md §7.

import { hashDoc, verifyDoc } from "../../protocol/crypto.ts";
import type { BankDB } from "../db.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type ConfirmReceiptParams = {
  tx_hash: string;
  user_confirm: Record<string, unknown>;
};

export const confirmReceipt: Handler = async (params, ctx) => {
  const p = params as ConfirmReceiptParams;
  if (typeof p.tx_hash !== "string" || !p.user_confirm) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash and params.user_confirm required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);
  }
  if (txState.state !== "held" && txState.state !== "confirmed") {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `tx must be 'held' or 'confirmed' to accept confirm_receipt; got '${txState.state}'`,
    );
  }

  const uc = p.user_confirm as Record<string, unknown>;
  if (
    uc.pubkey !== ctx.senderPubkey ||
    uc.hash !== p.tx_hash ||
    uc.action !== "settle" ||
    typeof uc.sig !== "string" ||
    !verifyDoc(uc, uc.sig, ctx.senderPubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "user_confirm signature invalid");
  }

  await ctx.db.insertDoc({ hash: hashDoc(uc), type: "signature", pubkey: ctx.senderPubkey, body: uc });

  const legConfirmed = await haveAllLegConfirms(ctx, p.tx_hash);
  if (legConfirmed && txState.state !== "confirmed") {
    await ctx.db.upsertTx({ txHash: p.tx_hash, state: "confirmed" });
  }

  return {
    tx_hash: p.tx_hash,
    confirmed_by_sender: true,
    leg_confirmed: legConfirmed,
    note: legConfirmed
      ? "this bank's leg is fully confirmed; awaiting settle cascade"
      : "stored; waiting for the other holders on this bank's leg",
  };
};

/**
 * True iff every distinct holder appearing in THIS bank's own records for the
 * Tx has stored a settle-action signature over the Tx hash. A bank only sees
 * its own leg, so the gate is scoped to its own records' holders.
 */
async function haveAllLegConfirms(
  ctx: { db: BankDB; bankPubkey: string },
  txHash: string,
): Promise<boolean> {
  const txRow = await ctx.db.getDoc(txHash);
  if (!txRow) return false;
  const recordHashes = (txRow.body as { records: string[] }).records;
  const recordRows = await ctx.db.getDocsByHashes(recordHashes);

  const holders = new Set<string>();
  for (const h of recordHashes) {
    const rec = recordRows[h];
    if (!rec || rec.pubkey !== ctx.bankPubkey) continue;
    const acct = await ctx.db.getAccount(rec.account as string);
    if (acct) holders.add(acct.holder_pubkey);
  }
  if (holders.size === 0) return false;

  for (const holder of holders) {
    const sig = await ctx.db.findActionSig(holder, txHash, "settle");
    if (!sig) return false;
  }
  return true;
}
