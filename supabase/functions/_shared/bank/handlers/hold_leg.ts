// hold_leg — proposing client → each participating bank.
//
// After every bank has approved its leg, the client asks each to lock the
// debit accounts in its own records. A conflict (`-32003`) means some account
// is already held by another in-flight Tx; the client reacts by calling
// reject_leg everywhere and aborting. The bank signs a `hold` and returns it.

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type HoldLegParams = { tx_hash: string };

export const holdLeg: Handler = async (params, ctx) => {
  const p = params as HoldLegParams;
  if (typeof p.tx_hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash required");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known to this bank`);
  }
  if (txState.state !== "approved" && txState.state !== "held") {
    throw new RpcError(RpcErrors.VALIDATION, `tx state must be 'approved' to hold; got '${txState.state}'`);
  }

  const txRow = await ctx.db.getDoc(p.tx_hash);
  if (!txRow) throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx body ${p.tx_hash} missing`);
  if ((txRow.body as { pubkey: string }).pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "hold_leg caller must be the Tx proposer");
  }

  const recordUlids = (txRow.body as { records: string[] }).records;
  const recordRows = await ctx.db.getLedgerRecordsByUlids(recordUlids);

  // One account may be debited by several records in the same Tx (e.g. a holder
  // paying two counterparties). The hold is per-account, so dedupe and sum the
  // amounts — a single account gets a single lock for the whole Tx.
  const amountByAccount = new Map<string, number>();
  for (const u of recordUlids) {
    const rec = recordRows[u];
    if (!rec) continue; // not this bank's record (visibility: we don't hold its body)
    if (rec.pubkey === ctx.bankPubkey && rec.type === "debit") {
      const acct = rec.account as string;
      amountByAccount.set(acct, (amountByAccount.get(acct) ?? 0) + (rec.amount as number));
    }
  }
  const debitAccounts = [...amountByAccount].map(([accountHash, amount]) => ({ accountHash, amount }));
  if (debitAccounts.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "no owned debit accounts on this bank");
  }

  const acquired: string[] = [];
  try {
    for (const da of debitAccounts) {
      const ok = await ctx.db.acquireHold({ accountHash: da.accountHash, txHash: p.tx_hash, amount: da.amount });
      if (!ok) {
        throw new RpcError(RpcErrors.LOCK_CONFLICT, `account ${da.accountHash} already held by another tx`);
      }
      acquired.push(da.accountHash);
    }
  } catch (err) {
    for (const a of acquired) await ctx.db.releaseHold(a, p.tx_hash);
    throw err;
  }

  const hold: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: p.tx_hash,
    action: "hold",
  };
  hold.sig = signDoc(hold, ctx.bankPrivateKey);
  await ctx.db.insertDoc({ hash: hashDoc(hold), type: "signature", pubkey: ctx.bankPubkey, body: hold });

  await ctx.db.upsertTx({ txHash: p.tx_hash, state: "held" });

  return { tx_hash: p.tx_hash, hold, locked: acquired };
};
