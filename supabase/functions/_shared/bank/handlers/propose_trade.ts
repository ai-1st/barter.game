// propose_trade — user (Alice) → her home bank (lead bank).
//
// Alice initiates a bilateral trade: "I give X, get Y from Bob." The lead
// bank constructs the Tx + 4 records, signs, calls approve_trade on the
// peer bank, then on success it acquires its own holds and tells the peer
// to do the same. On success, the Tx is in `held` state on both banks.
//
// Params:
//   give: { promise_hash, amount,
//           sender_account_hash, peer_account_hash,
//           issuer_bank_url, issuer_bank_pubkey }
//   get:  { promise_hash, amount,
//           sender_account_hash, peer_account_hash,
//           issuer_bank_url, issuer_bank_pubkey }
//   peer_pubkey: <counterparty user pubkey>
//
// Bank acts on records whose `account` is one of its own accounts. For a
// trade where THIS bank is the lead (= issuer of the give-side), records
// r1 (debit sender, give-side) and r2 (credit peer, give-side) are mine.

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { callPeer } from "../peer.ts";

type LegParams = {
  promise_hash: string;
  amount: number;
  sender_account_hash: string;
  peer_account_hash: string;
  issuer_bank_url: string;
  issuer_bank_pubkey: string;
};

type ProposeTradeParams = {
  give: LegParams;
  get: LegParams;
  peer_pubkey: string;
  // The lead bank's own public URL — supplied by the CLI which knows its
  // home bank URL. The follow bank stores this in bank_peers for
  // forward_confirm / notify_settle callbacks.
  lead_bank_url: string;
};

function validateLeg(leg: unknown, label: string): asserts leg is LegParams {
  if (!leg || typeof leg !== "object") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${label} required`);
  }
  const l = leg as Record<string, unknown>;
  for (const f of [
    "promise_hash",
    "sender_account_hash",
    "peer_account_hash",
    "issuer_bank_url",
    "issuer_bank_pubkey",
  ]) {
    if (typeof l[f] !== "string" || (l[f] as string).length === 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${label}.${f} required`);
    }
  }
  if (typeof l.amount !== "number" || !Number.isFinite(l.amount) || l.amount <= 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${label}.amount must be positive`);
  }
}

export const proposeTrade: Handler = async (params, ctx) => {
  const p = params as ProposeTradeParams;
  validateLeg(p.give, "give");
  validateLeg(p.get, "get");
  if (typeof p.peer_pubkey !== "string" || p.peer_pubkey.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.peer_pubkey required");
  }
  if (typeof p.lead_bank_url !== "string" || !p.lead_bank_url.startsWith("http")) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.lead_bank_url required");
  }

  // Lead bank rule: the give-side issuer bank must be THIS bank. We're acting
  // as Alice's lead bank, which by design is the bank that holds Alice's
  // outgoing promise. (Same-bank trades where both sides are at one bank
  // are also lead by that bank.)
  if (p.give.issuer_bank_pubkey !== ctx.bankPubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `lead-bank rule: give.issuer_bank_pubkey (${p.give.issuer_bank_pubkey}) must equal this bank (${ctx.bankPubkey})`,
    );
  }

  // Validate that this bank knows the give-side accounts and they belong to
  // the claimed parties.
  const senderGiveAcct = await ctx.db.getAccount(p.give.sender_account_hash);
  if (!senderGiveAcct) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `give.sender_account_hash not known to this bank`);
  }
  if (senderGiveAcct.holder_pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, `give.sender_account_hash does not belong to sender`);
  }
  if (senderGiveAcct.promise_hash !== p.give.promise_hash) {
    throw new RpcError(RpcErrors.VALIDATION, `give.sender_account_hash promise mismatch`);
  }
  const peerGiveAcct = await ctx.db.getAccount(p.give.peer_account_hash);
  if (!peerGiveAcct) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `give.peer_account_hash not known to this bank`);
  }
  if (peerGiveAcct.holder_pubkey !== p.peer_pubkey) {
    throw new RpcError(RpcErrors.VALIDATION, `give.peer_account_hash does not belong to peer`);
  }
  if (peerGiveAcct.promise_hash !== p.give.promise_hash) {
    throw new RpcError(RpcErrors.VALIDATION, `give.peer_account_hash promise mismatch`);
  }

  // Same-bank fast path: if get.issuer_bank == this bank, we own both sides.
  const sameBank = p.get.issuer_bank_pubkey === ctx.bankPubkey;

  // Build records. v1 cap = 4 (2 transfer pairs). The bank's own pubkey
  // appears in `pubkey` of the records we own; for cross-bank records we
  // tag them with the peer bank's pubkey so it's clear who owns/processes
  // which record.
  const r1: Record<string, unknown> = {       // debit sender, give-side
    type: "debit",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    account: p.give.sender_account_hash,
    amount: p.give.amount,
  };
  const r2: Record<string, unknown> = {       // credit peer, give-side
    type: "credit",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    account: p.give.peer_account_hash,
    amount: p.give.amount,
  };
  const r3: Record<string, unknown> = {       // debit peer, get-side (at follow bank)
    type: "debit",
    pubkey: p.get.issuer_bank_pubkey,
    ulid: newUlid(),
    account: p.get.peer_account_hash,
    amount: p.get.amount,
  };
  const r4: Record<string, unknown> = {       // credit sender, get-side (at follow bank)
    type: "credit",
    pubkey: p.get.issuer_bank_pubkey,
    ulid: newUlid(),
    account: p.get.sender_account_hash,
    amount: p.get.amount,
  };

  const r1Hash = hashDoc(r1);
  const r2Hash = hashDoc(r2);
  const r3Hash = hashDoc(r3);
  const r4Hash = hashDoc(r4);

  const tx: Record<string, unknown> = {
    type: "tx",
    pubkey: ctx.senderPubkey,                 // Alice (the lead user) owns this Tx
    ulid: newUlid(),
    records: [r1Hash, r2Hash, r3Hash, r4Hash],
  };
  const txHash = hashDoc(tx);

  // Persist all records + tx on THIS bank.
  for (const [body, hash] of [
    [r1, r1Hash],
    [r2, r2Hash],
    [r3, r3Hash],
    [r4, r4Hash],
  ] as const) {
    await ctx.db.insertDoc({
      hash,
      type: body.type as string,
      pubkey: body.pubkey as string,
      body,
    });
  }
  await ctx.db.insertDoc({ hash: txHash, type: "tx", pubkey: ctx.senderPubkey, body: tx });
  await ctx.db.upsertTx({
    txHash,
    state: "proposed",
    leadBankPubkey: ctx.bankPubkey,
    followBankPubkey: sameBank ? ctx.bankPubkey : p.get.issuer_bank_pubkey,
  });

  // Bank's own approve signature for THIS bank's leg.
  const leadApprove: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "approve",
  };
  leadApprove.sig = signDoc(leadApprove, ctx.bankPrivateKey);
  const leadApproveHash = hashDoc(leadApprove);
  await ctx.db.insertDoc({
    hash: leadApproveHash,
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: leadApprove,
  });

  if (sameBank) {
    // Same-bank trade: bank handles both legs. Approve, hold, settle inline.
    // For demo brevity we collapse to immediate-settle: this is not the
    // primary flow we're optimizing for (cross-bank IS the demo) but supports
    // a single-user dogfood case.
    await ctx.db.upsertTx({ txHash, state: "approved" });
    return {
      tx_hash: txHash,
      state: "approved-same-bank",
      lead_approve: leadApprove,
      records: { r1: r1Hash, r2: r2Hash, r3: r3Hash, r4: r4Hash },
      note: "same-bank trade flow stops here in v1 demo; cross-bank is the optimized path",
    };
  }

  // Remember the peer's URL so we can call it later (notify_settle).
  await ctx.db.rememberPeer(p.get.issuer_bank_pubkey, p.get.issuer_bank_url);

  // Cross-bank: call approve_trade on the follow bank.
  const approveResult = await callPeer({
    bankUrl: p.get.issuer_bank_url,
    bankPubkey: ctx.bankPubkey,
    bankPrivateKey: ctx.bankPrivateKey,
    peerPubkey: p.get.issuer_bank_pubkey,
    method: "approve_trade",
    params: {
      tx,
      records: [r1, r2, r3, r4],
      lead_bank_pubkey: ctx.bankPubkey,
      lead_bank_url: p.lead_bank_url,
      lead_user_pubkey: ctx.senderPubkey,
      peer_user_pubkey: p.peer_pubkey,
      lead_approve: leadApprove,
    },
  });
  if (approveResult.error) {
    await ctx.db.upsertTx({ txHash, state: "rejected" });
    throw new RpcError(
      approveResult.error.code,
      `peer approve_trade failed: ${approveResult.error.message}`,
      approveResult.error.data,
    );
  }
  const followApprove = (approveResult.result as { follow_approve?: Record<string, unknown> })?.follow_approve;
  if (followApprove && typeof followApprove === "object") {
    const faHash = hashDoc(followApprove);
    await ctx.db.insertDoc({
      hash: faHash,
      type: "signature",
      pubkey: (followApprove as Record<string, unknown>).pubkey as string,
      body: followApprove as Record<string, unknown>,
    });
  }
  await ctx.db.upsertTx({ txHash, state: "approved" });

  // Acquire the lead bank's own hold (lock sender's give-side account).
  const leadHoldOk = await ctx.db.acquireHold({
    accountHash: p.give.sender_account_hash,
    txHash,
    amount: p.give.amount,
  });
  if (!leadHoldOk) {
    await ctx.db.upsertTx({ txHash, state: "rejected" });
    throw new RpcError(RpcErrors.LOCK_CONFLICT, `give.sender_account already held by another tx`);
  }

  // Sign and persist lead's own hold sig.
  const leadHold: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "hold",
  };
  leadHold.sig = signDoc(leadHold, ctx.bankPrivateKey);
  await ctx.db.insertDoc({
    hash: hashDoc(leadHold),
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: leadHold,
  });

  // Call hold on the follow bank.
  const holdResult = await callPeer({
    bankUrl: p.get.issuer_bank_url,
    bankPubkey: ctx.bankPubkey,
    bankPrivateKey: ctx.bankPrivateKey,
    peerPubkey: p.get.issuer_bank_pubkey,
    method: "hold",
    params: {
      tx_hash: txHash,
      lead_hold: leadHold,
    },
  });
  if (holdResult.error) {
    // Release our own hold and reject.
    await ctx.db.releaseHold(p.give.sender_account_hash, txHash);
    await ctx.db.upsertTx({ txHash, state: "rejected" });
    throw new RpcError(
      holdResult.error.code,
      `peer hold failed: ${holdResult.error.message}`,
      holdResult.error.data,
    );
  }

  await ctx.db.upsertTx({ txHash, state: "held" });

  return {
    tx_hash: txHash,
    state: "held",
    lead_bank: ctx.bankPubkey,
    follow_bank: p.get.issuer_bank_pubkey,
    records: { r1: r1Hash, r2: r2Hash, r3: r3Hash, r4: r4Hash },
    next: "both parties must call confirm_receipt on their respective banks, then lead settles",
  };
};
