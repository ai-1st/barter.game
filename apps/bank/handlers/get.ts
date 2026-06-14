// Read-only handlers and Address directory storage.

import { hashDoc, signDoc, validateDoc, verifyDoc } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler, type RpcContext } from "../rpc.ts";

export const getPromise: Handler = async (params, ctx) => {
  const hash = (params as { promise_hash?: string }).promise_hash;
  if (typeof hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.promise_hash required");
  }
  const row = await ctx.db.getDoc(hash);
  if (!row) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `promise ${hash} not found`);
  }
  if (row.type !== "promise") {
    throw new RpcError(RpcErrors.VALIDATION, `doc ${hash} is type ${row.type}, not promise`);
  }
  return { promise: row.body };
};

export const getAccountBalance: Handler = async (params, ctx) => {
  const hash = (params as { account_hash?: string }).account_hash;
  if (typeof hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.account_hash required");
  }
  const accountRow = await ctx.db.getAccount(hash);
  if (!accountRow) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${hash} not found`);
  }
  return {
    account_hash: accountRow.account_hash,
    promise_hash: accountRow.promise_hash,
    pocket_hash: accountRow.pocket_hash,
    holder_pubkey: accountRow.holder_pubkey,
    balance: accountRow.balance,
  };
};

/** list_accounts — accounts owned by sender at this bank, with Promise bodies. */
export const listAccounts: Handler = async (_params, ctx) => {
  const accounts = await ctx.db.listAccountsByHolder(ctx.senderPubkey);
  const promiseHashes = [...new Set(accounts.map((a) => a.promise_hash))];
  const promises = await ctx.db.getDocsByHashes(promiseHashes);
  return { accounts, promises };
};

/**
 * Store or update an Address doc for the pubkey it describes.
 * A newer Address (by ULID) for the same pubkey replaces the older one.
 * Used by both the JSON-RPC method and the plain HTTP POST /address endpoint.
 */
export async function submitAddress(
  addressDoc: unknown,
  ctx: Pick<RpcContext, "db" | "bankPrivateKey">,
): Promise<Record<string, unknown>> {
  if (addressDoc === null || typeof addressDoc !== "object" || Array.isArray(addressDoc)) {
    throw new Error("address must be an object");
  }
  const a = addressDoc as Record<string, unknown>;
  if (a.type !== "address") throw new Error("doc.type must be 'address'");
  if (typeof a.pubkey !== "string" || typeof a.ulid !== "string" || typeof a.url !== "string") {
    throw new Error("address must have pubkey, ulid, and url");
  }
  // Verify the address signature if present.
  if (typeof a.sig === "string") {
    if (!verifyDoc(a, a.sig, a.pubkey)) {
      throw new Error("address signature invalid");
    }
  }

  const existing = await ctx.db.getDoc(a.pubkey);
  if (existing && existing.type === "address") {
    const old = existing.body as Record<string, unknown>;
    if (typeof old.ulid === "string" && old.ulid >= a.ulid) {
      throw new Error("existing address has same or newer ulid");
    }
  }

  // If no sig, sign it as this bank (for self-published addresses).
  if (typeof a.sig !== "string") {
    a.sig = signDoc(a, ctx.bankPrivateKey);
  }

  const hash = hashDoc(a);
  await ctx.db.insertDoc({ hash, type: "address", pubkey: a.pubkey, body: a });
  return a;
}
