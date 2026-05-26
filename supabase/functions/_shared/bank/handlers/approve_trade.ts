// approve_trade — lead bank → follow bank.
//
// The follow bank validates the Tx + records + lead-bank approve sig, finds
// the records it owns (records whose `account` is one of its own accounts),
// signs an `approve` Signature, persists everything, returns the sig.

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type ApproveTradeParams = {
  tx: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  lead_bank_pubkey: string;
  lead_bank_url: string;             // so the follow bank can call back later
  lead_user_pubkey: string;
  peer_user_pubkey: string;
  lead_approve: Record<string, unknown>;
};

export const approveTrade: Handler = async (params, ctx) => {
  const p = params as ApproveTradeParams;
  if (!p.tx || !Array.isArray(p.records) || p.records.length !== 4) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "tx + 4 records required");
  }

  // Caller must be a bank (envelope.pubkey == lead_bank_pubkey).
  if (ctx.senderPubkey !== p.lead_bank_pubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      "approve_trade caller must equal lead_bank_pubkey from params",
    );
  }
  if (typeof p.lead_bank_url !== "string" || !p.lead_bank_url.startsWith("http")) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.lead_bank_url required (https URL)");
  }
  // Remember the peer's URL so we can call it back (forward_confirm etc).
  await ctx.db.rememberPeer(p.lead_bank_pubkey, p.lead_bank_url);

  // Verify lead bank's approve signature over the Tx hash.
  const txHash = hashDoc(p.tx);
  if (
    typeof p.lead_approve?.sig !== "string" ||
    p.lead_approve.pubkey !== p.lead_bank_pubkey ||
    (p.lead_approve as Record<string, unknown>).hash !== txHash ||
    !verifyDoc(p.lead_approve, p.lead_approve.sig as string, p.lead_bank_pubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "lead_approve signature invalid for this tx");
  }

  // Validate record hashes match Tx.records[].
  const recordHashes = p.records.map((r) => hashDoc(r));
  const txRecords = (p.tx as { records?: unknown[] }).records;
  if (!Array.isArray(txRecords) || txRecords.length !== 4) {
    throw new RpcError(RpcErrors.VALIDATION, "tx.records must have 4 hashes");
  }
  for (let i = 0; i < 4; i++) {
    if (recordHashes[i] !== txRecords[i]) {
      throw new RpcError(
        RpcErrors.VALIDATION,
        `record[${i}] hash mismatch with tx.records[${i}]`,
      );
    }
  }

  // Find records owned by THIS bank (records[i].pubkey === ctx.bankPubkey).
  const ownedIndexes: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (p.records[i]!.pubkey === ctx.bankPubkey) ownedIndexes.push(i);
  }
  if (ownedIndexes.length !== 2) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `this bank must own exactly 2 records; owns ${ownedIndexes.length}`,
    );
  }
  // The two owned records must be debit + credit on different accounts.
  const owned = ownedIndexes.map((i) => p.records[i]!);
  const types = new Set(owned.map((r) => r.type as string));
  if (!(types.has("debit") && types.has("credit"))) {
    throw new RpcError(RpcErrors.VALIDATION, "owned records must be one debit + one credit");
  }

  // Verify both owned accounts exist at this bank, and the debit account has
  // enough balance (or is the issuer's own account, which goes negative).
  for (const rec of owned) {
    const accountHash = rec.account as string;
    const acct = await ctx.db.getAccount(accountHash);
    if (!acct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${accountHash} not known to this bank`);
    }
    // For now we don't enforce balance ceilings (mutual credit, see design's
    // "Mutual-Credit Balance Semantics" section). v1.5 adds Promise.limit
    // enforcement at hold-time.
  }

  // Persist all records + tx on THIS bank too. Idempotent on hash.
  for (const rec of p.records) {
    await ctx.db.insertDoc({
      hash: hashDoc(rec),
      type: rec.type as string,
      pubkey: rec.pubkey as string,
      body: rec,
    });
  }
  await ctx.db.insertDoc({
    hash: txHash,
    type: "tx",
    pubkey: (p.tx as { pubkey: string }).pubkey,
    body: p.tx,
  });
  await ctx.db.insertDoc({
    hash: hashDoc(p.lead_approve),
    type: "signature",
    pubkey: p.lead_bank_pubkey,
    body: p.lead_approve,
  });
  await ctx.db.upsertTx({
    txHash,
    state: "approved",
    leadBankPubkey: p.lead_bank_pubkey,
    followBankPubkey: ctx.bankPubkey,
  });

  // Sign this bank's own approve.
  const followApprove: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "approve",
  };
  followApprove.sig = signDoc(followApprove, ctx.bankPrivateKey);
  await ctx.db.insertDoc({
    hash: hashDoc(followApprove),
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: followApprove,
  });

  return { follow_approve: followApprove };
};
