// open_account — user → bank that issued the Promise.
//
// Caller is the holder pre-creating an Account on the issuing bank. Used so a
// cross-bank trade has somewhere to settle the incoming Promise.
//
// Params:
//   account: signed Account doc (type "account", pubkey = holder, pocket, promise)
//   pocket?: signed Pocket doc (if pocket_hash references a new Pocket)
//
// The bank validates, persists, and returns the account_hash (which the
// holder may already have computed client-side — this is idempotent).

import { hashDoc } from "../../protocol/crypto.ts";
import { validateAccount, validatePocket } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type OpenAccountParams = {
  account: Record<string, unknown>;
  pocket?: Record<string, unknown>;
};

export const openAccount: Handler = async (params, ctx) => {
  const p = params as OpenAccountParams;
  if (!p.account) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.account required");
  }
  try {
    validateAccount(p.account);
  } catch (err) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      err instanceof Error ? err.message : "account validation failed",
    );
  }
  const account = p.account as Record<string, unknown>;

  if (account.pubkey !== ctx.senderPubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      "account.pubkey must equal the request sender (holder opens their own account)",
    );
  }

  const promiseHash = account.promise as string;
  const promiseRow = await ctx.db.getDoc(promiseHash);
  if (!promiseRow) {
    throw new RpcError(
      RpcErrors.UNKNOWN_DOC,
      `promise ${promiseHash} not known to this bank`,
    );
  }
  const promiseDoc = promiseRow.body as Record<string, unknown>;
  if (promiseDoc.bank !== ctx.bankPubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      "this bank does not issue that promise",
    );
  }

  // Persist Pocket if supplied. Validators throw on bad shape.
  let pocketHash = account.pocket as string;
  if (p.pocket) {
    try {
      validatePocket(p.pocket);
    } catch (err) {
      throw new RpcError(
        RpcErrors.VALIDATION,
        err instanceof Error ? err.message : "pocket validation failed",
      );
    }
    const computed = hashDoc(p.pocket);
    if (computed !== pocketHash) {
      throw new RpcError(
        RpcErrors.VALIDATION,
        `account.pocket hash mismatch: account references ${pocketHash} but supplied pocket hashes to ${computed}`,
      );
    }
    await ctx.db.insertDoc({
      hash: pocketHash,
      type: "pocket",
      pubkey: ctx.senderPubkey,
      body: p.pocket as Record<string, unknown>,
    });
  }

  const accountHash = hashDoc(account);
  await ctx.db.insertDoc({
    hash: accountHash,
    type: "account",
    pubkey: ctx.senderPubkey,
    body: account,
  });
  await ctx.db.upsertAccount({
    accountHash,
    promiseHash,
    pocketHash,
    holderPubkey: ctx.senderPubkey,
    initialBalance: 0,
    acknowledged: true,        // user opened it themselves → already acknowledged
  });

  return {
    account_hash: accountHash,
    promise_hash: promiseHash,
    pocket_hash: pocketHash,
    bank: ctx.bankPubkey,
  };
};
