// submit_tx — the heart of direct approval (wave 1).
//
// A Tx is ONE HOLDER's view of a deal: tx.pubkey is the holder, tx.records
// are the ULIDs of the records on that holder's accounts. The holder signs
// a lead/follow Signature over the Tx hash — that signature is the
// authorization for banks to execute those records. It subsumes the old
// proposer-approve AND confirm_receipt: a holder signing a Tx containing a
// credit IS their receipt confirmation.
//
// The envelope sender may differ from the holder — anyone can relay a
// signed Tx, which is what makes client-carried topology work. Authority
// lives in holder_sig, not in the envelope.
//
// The bank checks the limits and validity of each record it owns and issues
// a per-record `approve` or `reject` Signature. Once EVERY record this bank
// owns under the deal is bound to a holder-signed Tx and bank-approved, the
// leg advances to `approved` and the bank self-advances (holds, then
// settles per the lead/follow order) — see advance.ts.

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { validateSignature, validateTx } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler, type RpcContext } from "../rpc.ts";
import type { LedgerRecordRow } from "../db.ts";
import { advanceDeal } from "../advance.ts";
import { fanoutSignatures } from "../subscriptions.ts";
import { intakeDocs } from "./intake.ts";

type SubmitTxParams = {
  tx: Record<string, unknown>;
  holder_sig: Record<string, unknown>;
  docs?: unknown[];
};

export const submitTx: Handler = async (params, ctx) => {
  const p = params as SubmitTxParams;
  if (!p.tx || !p.holder_sig) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx and params.holder_sig required");
  }

  try {
    validateTx(p.tx);
    validateSignature(p.holder_sig);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "doc validation failed");
  }

  const tx = p.tx as { pubkey: string; ulid: string; records: string[] };
  const txHash = hashDoc(p.tx);
  const hs = p.holder_sig;
  if (
    hs.pubkey !== tx.pubkey ||
    hs.hash !== txHash ||
    (hs.action !== "lead" && hs.action !== "follow") ||
    typeof hs.sig !== "string" ||
    !verifyDoc(hs, hs.sig as string, tx.pubkey)
  ) {
    throw new RpcError(
      RpcErrors.SIG_INVALID,
      "holder_sig must be a valid lead/follow signature by tx.pubkey over the tx hash",
    );
  }

  // Implicit accounts: the holder's Account docs may arrive with this call.
  await intakeDocs(p.docs, ctx);

  // This bank's slice of the Tx — records it owns. Others are invisible.
  const recordBodies = await ctx.db.getLedgerRecordsByUlids(tx.records);
  const ownedUlids = tx.records.filter((u) => recordBodies[u] !== undefined);
  if (ownedUlids.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "this bank owns no records in tx.records[]");
  }

  // All owned records must belong to one deal, and every record a holder
  // authorizes must sit on the holder's own account.
  let deal: string | null = null;
  const rows: LedgerRecordRow[] = [];
  for (const u of ownedUlids) {
    const row = await ctx.db.getLedgerRecord(u);
    if (!row) throw new RpcError(RpcErrors.UNKNOWN_DOC, `record ${u} not found at this bank`);
    if (deal === null) deal = row.deal_ulid;
    if (row.deal_ulid !== deal) {
      throw new RpcError(RpcErrors.VALIDATION, "tx.records span multiple deals at this bank");
    }
    if (row.tx_ulid !== null && row.tx_ulid !== tx.ulid) {
      throw new RpcError(RpcErrors.VALIDATION, `record ${u} is already bound to another tx`);
    }
    const acct = await ctx.db.getAccount(row.account);
    if (!acct) throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${row.account} not known (attach the Account doc)`);
    if (acct.holder_pubkey !== tx.pubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `record ${u} sits on an account not owned by tx.pubkey`);
    }
    rows.push(row);
  }

  // Persist the holder's view + authorization; bind our records to the Tx.
  await ctx.db.insertDoc({ hash: txHash, type: "tx", pubkey: tx.pubkey, body: p.tx });
  await ctx.db.insertDoc({ hash: hashDoc(hs), type: "signature", pubkey: tx.pubkey, body: hs });
  await ctx.db.bindRecordsToTx(ownedUlids, tx.ulid);

  // Per-record validity/limit check → per-record approve or reject.
  const recordSigs: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const existing = await ctx.db.findActionSig(ctx.bankPubkey, { record: row.ulid }, "approve")
      ?? await ctx.db.findActionSig(ctx.bankPubkey, { record: row.ulid }, "reject");
    if (existing) {
      recordSigs.push(existing); // idempotent re-submit
      continue;
    }
    const reason = await checkRecord(row, ctx);
    const sig: Record<string, unknown> = {
      type: "signature",
      pubkey: ctx.bankPubkey,
      ulid: newUlid(),
      record: row.ulid,
      action: reason === null ? "approve" : "reject",
    };
    if (reason !== null) sig.reason = reason;
    sig.sig = signDoc(sig, ctx.bankPrivateKey);
    await ctx.db.insertDoc({ hash: hashDoc(sig), type: "signature", pubkey: ctx.bankPubkey, body: sig });
    recordSigs.push(sig);
  }

  // Leg gate: approved once EVERY record this bank owns under the deal is
  // Tx-bound and carries a bank approve. (The credit holder's Tx signature
  // is exactly the old receipt confirmation.)
  const leg = await ctx.db.getLegState(deal!);
  let legState = leg?.state ?? "created";
  if (legState === "created") {
    const allRecords = await ctx.db.getLedgerRecordsByDeal(deal!);
    let complete = true;
    for (const rec of allRecords) {
      const bound = rec.tx_ulid !== null || ownedUlids.includes(rec.ulid);
      const approved = await ctx.db.findActionSig(ctx.bankPubkey, { record: rec.ulid }, "approve");
      if (!bound || !approved) {
        complete = false;
        break;
      }
    }
    if (complete) {
      await ctx.db.upsertLeg({ dealUlid: deal!, state: "approved" });
      legState = "approved";
    }
  }

  await fanoutSignatures(ctx, recordSigs);

  // Banks self-advance: holds + settles happen here, not on a client command.
  await advanceDeal(deal!, ctx);
  const after = await ctx.db.getLegState(deal!);

  return {
    tx_hash: txHash,
    deal,
    record_sigs: recordSigs,
    leg_state: after?.state ?? legState,
  };
};

/** v0 limit policy at approve time. Returns null (approve) or a reason (reject). */
async function checkRecord(row: LedgerRecordRow, ctx: RpcContext): Promise<string | null> {
  if (row.type === "credit") return null; // credits always approve

  const acct = await ctx.db.getAccount(row.account);
  if (!acct) return `account ${row.account} unknown`;
  const promiseRow = await ctx.db.getDoc(acct.promise_hash);
  const promise = promiseRow?.body as { pubkey?: string; limit?: number } | undefined;
  const isIssuer = promise?.pubkey === acct.holder_pubkey;
  const balance = Number(acct.balance);
  const amount = Number(row.amount);

  if (isIssuer) {
    // Issuer accounts may go negative up to -promise.limit (if set).
    if (typeof promise?.limit === "number" && -(balance - amount) > promise.limit) {
      return `debit would exceed promise.limit ${promise.limit}`;
    }
    return null;
  }
  // Non-issuer debit: balance net of active holds must cover the amount.
  const held = await ctx.db.getActiveHoldAmount(row.account);
  if (balance - held - amount < 0) {
    return `insufficient balance: ${balance} - ${held} held < ${amount}`;
  }
  return null;
}
