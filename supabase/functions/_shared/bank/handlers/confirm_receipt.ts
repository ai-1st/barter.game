// confirm_receipt — user → their own bank.
//
// User signs "I received the off-chain delivery." Bank persists the user's
// signed doc, then forwards it to the counterparty bank via forward_confirm.
// Once BOTH user confirms are received on a bank, that bank knows the off-
// chain delivery is acknowledged on both sides.

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { callPeer } from "../peer.ts";

type ConfirmReceiptParams = {
  tx_hash: string;
  user_confirm: Record<string, unknown>;   // user-signed sig doc
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

  // Verify user's sig.
  const uc = p.user_confirm as Record<string, unknown>;
  if (
    uc.pubkey !== ctx.senderPubkey ||
    uc.hash !== p.tx_hash ||
    uc.action !== "settle" ||              // user signs settle = "I confirm receipt, please settle"
    typeof uc.sig !== "string" ||
    !verifyDoc(uc, uc.sig, ctx.senderPubkey)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "user_confirm signature invalid");
  }

  await ctx.db.insertDoc({
    hash: hashDoc(uc),
    type: "signature",
    pubkey: ctx.senderPubkey,
    body: uc,
  });

  // Forward to the counterparty bank so it has the user's signed receipt.
  const peerBankPubkey =
    ctx.bankPubkey === txState.lead_bank_pubkey
      ? txState.follow_bank_pubkey
      : txState.lead_bank_pubkey;
  let forwardDiag: unknown = null;
  if (peerBankPubkey && peerBankPubkey !== ctx.bankPubkey) {
    const peerBankUrl = await ctx.db.lookupPeerUrl(peerBankPubkey);
    if (!peerBankUrl) {
      forwardDiag = { error: "no peer URL in bank_peers", peerBankPubkey };
    } else {
      try {
        const r = await callPeer({
          bankUrl: peerBankUrl,
          bankPubkey: ctx.bankPubkey,
          bankPrivateKey: ctx.bankPrivateKey,
          peerPubkey: peerBankPubkey,
          method: "forward_confirm",
          params: {
            tx_hash: p.tx_hash,
            user_confirm: uc,
          },
        });
        forwardDiag = r;
      } catch (err) {
        forwardDiag = { thrown: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  // Check whether both user confirms are present on THIS bank.
  const bothConfirmed = await haveBothUserConfirms(ctx, p.tx_hash);
  if (bothConfirmed) {
    await ctx.db.upsertTx({ txHash: p.tx_hash, state: "confirmed" });
  }

  return {
    tx_hash: p.tx_hash,
    confirmed_by_sender: true,
    both_confirmed: bothConfirmed,
    note: bothConfirmed ? "tx is in 'confirmed' state; lead bank will settle next" : "waiting for peer's confirm",
    forward_diag: forwardDiag,
  };
};

/**
 * forward_confirm — bank → bank.
 * The peer bank forwards a user_confirm doc that originated on the other
 * bank. Storing it locally lets settle() check that both users have signed.
 */
export const forwardConfirm: Handler = async (params, ctx) => {
  const p = params as ConfirmReceiptParams;
  if (typeof p.tx_hash !== "string" || !p.user_confirm) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.tx_hash and params.user_confirm required");
  }
  // Verify the inner user sig (caller is a peer bank; user sig must still be valid).
  const uc = p.user_confirm as Record<string, unknown>;
  if (
    typeof uc.sig !== "string" ||
    uc.hash !== p.tx_hash ||
    uc.action !== "settle" ||
    !verifyDoc(uc, uc.sig, uc.pubkey as string)
  ) {
    throw new RpcError(RpcErrors.SIG_INVALID, "forwarded user_confirm signature invalid");
  }

  const txState = await ctx.db.getTxState(p.tx_hash);
  if (!txState) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `tx ${p.tx_hash} not known`);
  }

  await ctx.db.insertDoc({
    hash: hashDoc(uc),
    type: "signature",
    pubkey: uc.pubkey as string,
    body: uc,
  });

  const bothConfirmed = await haveBothUserConfirms(ctx, p.tx_hash);
  if (bothConfirmed && (txState.state === "held" || txState.state === "confirmed")) {
    await ctx.db.upsertTx({ txHash: p.tx_hash, state: "confirmed" });
  }
  return { tx_hash: p.tx_hash, both_confirmed: bothConfirmed };
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns true if THIS bank has stored user-confirm signatures from BOTH
 * the lead user (Tx.pubkey) and the peer user. We look up the Tx body,
 * find the two distinct user pubkeys involved, and check we have a settle-
 * action signature from each over the Tx hash.
 */
async function haveBothUserConfirms(
  ctx: { db: import("../db.ts").BankDB; bankPubkey: string },
  txHash: string,
): Promise<boolean> {
  const txRow = await ctx.db.getDoc(txHash);
  if (!txRow) return false;
  const txBody = txRow.body as { records: string[]; pubkey: string };
  const recordHashes = txBody.records;
  const recordRows = await ctx.db.getDocsByHashes(recordHashes);

  // The two user pubkeys: Tx.pubkey is the lead user. The peer user is the
  // holder of the credit-record account that's NOT the lead user's
  // (specifically, the holder of the get-side credit on the peer bank IS
  // the lead user; the holder of the give-side credit on the lead bank IS
  // the peer user).
  // Walk both credit AND debit records; any holder we can resolve locally
  // who isn't the tx owner is the peer user.
  const userPubkeys = new Set<string>([txBody.pubkey]);
  for (const h of recordHashes) {
    const r = recordRows[h];
    if (!r) continue;
    const acct = await ctx.db.getAccount(r.account as string);
    if (acct && acct.holder_pubkey !== txBody.pubkey) {
      userPubkeys.add(acct.holder_pubkey);
    }
  }
  if (userPubkeys.size < 2) return false;

  // Look for a settle-action signature from each user over this tx.
  for (const pubkey of userPubkeys) {
    const { data, error } = await (ctx.db as unknown as {
      sb: import("npm:@supabase/supabase-js@^2.45.0").SupabaseClient;
    }).sb
      .from("docs")
      .select("hash")
      .eq("bank_pubkey", ctx.bankPubkey)
      .eq("type", "signature")
      .eq("pubkey", pubkey)
      .contains("body", { hash: txHash, action: "settle" })
      .limit(1);
    if (error) return false;
    if (!data || data.length === 0) return false;
  }
  return true;
}

