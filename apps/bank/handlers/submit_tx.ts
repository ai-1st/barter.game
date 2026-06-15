// submit_tx — the heart of direct approval (wave 1).
//
// A Tx is ONE HOLDER's view of a deal: tx.pubkey is the holder, tx.records
// are the content-addressed hashes of the records on that holder's accounts.
// The holder signs a lead/follow Signature over the Tx hash — that signature
// is the authorization for banks to execute those records.
//
// The envelope sender may differ from the holder — anyone can relay a
// signed Tx, which is what makes client-carried topology work. Authority
// lives in holder_signature, not in the envelope.
//
// The bank checks the limits and validity of each record it owns and issues
// a per-record `ready` or `reject` Signature (targeting the record hash).
// Ready promotes a draft record to the ready prefix. Once ready, the bank's
// advance engine pairs records by `pair` ULID and issues hold/settle.

import { hashDoc, newUlid, signDoc, verifyDoc, validateSignature, validateTx, hashRecord } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler, type RpcContext } from "../rpc.ts";
import type { RecordRow } from "../db.ts";
import { advanceRecord } from "../advance.ts";
import { fanoutSignatures } from "../subscriptions.ts";
import { intakeDocs } from "./intake.ts";

type SubmitTxParams = {
  tx: Record<string, unknown>;
  holder_signature?: Record<string, unknown>;
  docs?: unknown[];
};

export const submitTx: Handler = async (params, ctx) => {
  const p = params as SubmitTxParams;
  if (!p.tx) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx required");
  }

  try {
    validateTx(p.tx);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "tx validation failed");
  }

  const tx = p.tx as { pubkey: string; ulid: string; records: string[]; order?: string; offer?: string };
  const txHash = hashDoc(p.tx);

  // Validate holder signature if present.
  let hasHolderSig = false;
  if (p.holder_signature) {
    try {
      validateSignature(p.holder_signature);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "signature validation failed");
    }
    const hs = p.holder_signature;
    if (
      hs.pubkey !== tx.pubkey ||
      hs.hash !== txHash ||
      (hs.action !== "lead" && hs.action !== "follow") ||
      typeof hs.sig !== "string" ||
      !verifyDoc(hs, hs.sig as string, tx.pubkey)
    ) {
      throw new RpcError(
        RpcErrors.SIG_INVALID,
        "holder_signature must be a valid lead/follow signature by tx.pubkey over the tx hash",
      );
    }
    hasHolderSig = true;
  }

  // A lead Order/Offer referenced by the Tx can substitute for the holder signature.
  const authSource = await resolveAuthorizationSource(tx, ctx);
  if (!hasHolderSig && !authSource) {
    throw new RpcError(RpcErrors.SIG_INVALID, "tx requires a holder lead/follow signature or a lead Order/Offer");
  }

  // Implicit accounts: the holder's Account docs may arrive with this call.
  await intakeDocs(p.docs, ctx);

  // This bank's slice of the Tx — records it owns. Others are invisible.
  const owned: { hash: string; row: RecordRow }[] = [];
  for (const recordHash of tx.records) {
    const row = await ctx.db.getRecord(recordHash);
    if (!row) continue;
    if (row.body.pubkey !== ctx.bankPubkey) continue;
    owned.push({ hash: recordHash, row });
  }
  if (owned.length === 0) {
    throw new RpcError(RpcErrors.VALIDATION, "this bank owns no records in tx.records[]");
  }

  // Every record a holder authorizes must sit on the holder's own account.
  for (const { hash, row } of owned) {
    const acct = await ctx.db.getAccount(row.account);
    if (!acct) throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${row.account} not known (attach the Account doc)`);
    if (acct.holder_pubkey !== tx.pubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `record ${hash} sits on an account not owned by tx.pubkey`);
    }
  }

  // Persist the holder's view + authorization.
  await ctx.db.insertDoc({ hash: txHash, type: "tx", pubkey: tx.pubkey, body: p.tx });
  if (p.holder_signature) {
    await ctx.db.insertDoc({ hash: hashDoc(p.holder_signature), type: "signature", pubkey: tx.pubkey, body: p.holder_signature });
  }

  // Per-record validity/limit check → per-record ready or reject.
  const recordSigs: Array<Record<string, unknown>> = [];
  for (const { hash, row } of owned) {
    const existing = await ctx.db.findActionSig(ctx.bankPubkey, hash, "ready")
      ?? await ctx.db.findActionSig(ctx.bankPubkey, hash, "reject");
    if (existing) {
      recordSigs.push(existing); // idempotent re-submit
      continue;
    }
    const reason = await checkRecord(row, ctx);
    const sig: Record<string, unknown> = {
      type: "signature",
      pubkey: ctx.bankPubkey,
      ulid: newUlid(),
      hash,
      action: reason === null ? "ready" : "reject",
    };
    if (reason !== null) sig.reason = reason;
    sig.sig = signDoc(sig, ctx.bankPrivateKey);
    await ctx.db.insertDoc({ hash: hashDoc(sig), type: "signature", pubkey: ctx.bankPubkey, body: sig });
    recordSigs.push(sig);

    if (sig.action === "ready") {
      await ctx.db.moveRecord(hash, "draft", "ready");
      await advanceRecord(hash, txHash, ctx);
    }
  }

  await fanoutSignatures(ctx, recordSigs);

  return {
    tx_hash: txHash,
    record_sigs: recordSigs,
  };
};

/** Look for a lead Order or Offer referenced by the Tx that authorizes it. */
async function resolveAuthorizationSource(
  tx: { order?: string; offer?: string },
  ctx: RpcContext,
): Promise<{ type: "order" | "offer"; lead: boolean } | null> {
  const hash = tx.order ?? tx.offer;
  if (!hash) return null;
  const row = await ctx.db.getDoc(hash);
  if (!row) return null;
  if (row.type !== "order" && row.type !== "offer") return null;
  const body = row.body as Record<string, unknown>;
  if (body.lead !== true) return null;
  return { type: row.type as "order" | "offer", lead: true };
}

/** v1 limit policy at ready time. Returns null (ready) or a reason (reject). */
async function checkRecord(row: RecordRow, ctx: RpcContext): Promise<string | null> {
  if (row.type === "credit") return null; // credits always ready

  const acct = await ctx.db.getAccount(row.account);
  if (!acct) return `account ${row.account} unknown`;
  const voucherRow = await ctx.db.getDoc(acct.voucher_hash);
  const voucher = voucherRow?.body as { pubkey?: string; limit?: number } | undefined;
  const isIssuer = voucher?.pubkey === acct.holder_pubkey;
  const balance = Number(acct.balance);
  const amount = Number(row.amount);

  if (isIssuer) {
    // Issuer accounts may go negative up to -voucher.limit (if set).
    if (typeof voucher?.limit === "number" && -(balance - amount) > voucher.limit) {
      return `debit would exceed voucher.limit ${voucher.limit}`;
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
