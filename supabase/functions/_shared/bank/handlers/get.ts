// Read-only handlers.

import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

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
