// Read-only handlers.

import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

export const getVoucher: Handler = async (params, ctx) => {
  const hash = (params as { voucher_hash?: string }).voucher_hash;
  if (typeof hash !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.voucher_hash required");
  }
  const row = await ctx.db.getDoc(hash);
  if (!row) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `voucher ${hash} not found`);
  }
  if (row.type !== "voucher") {
    throw new RpcError(RpcErrors.VALIDATION, `doc ${hash} is type ${row.type}, not voucher`);
  }
  return { voucher: row.body };
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
    voucher_hash: accountRow.voucher_hash,
    pocket_hash: accountRow.pocket_hash,
    holder_pubkey: accountRow.holder_pubkey,
    balance: accountRow.balance,
  };
};

/** list_accounts — accounts owned by sender at this bank, with Voucher bodies. */
export const listAccounts: Handler = async (_params, ctx) => {
  const accounts = await ctx.db.listAccountsByHolder(ctx.senderPubkey);
  const voucherHashes = [...new Set(accounts.map((a) => a.voucher_hash))];
  const vouchers = await ctx.db.getDocsByHashes(voucherHashes);
  return { accounts, vouchers };
};
