// Bank RPC method registry. Wired by the Edge Function entrypoint.

import type { Registry } from "./rpc.ts";
import { mintPromise } from "./handlers/mint_promise.ts";
import { openAccount } from "./handlers/open_account.ts";
import { getAccountBalance, getPromise, listAccounts } from "./handlers/get.ts";
import { proposeTrade } from "./handlers/propose_trade.ts";
import { approveTrade } from "./handlers/approve_trade.ts";
import { hold } from "./handlers/hold.ts";
import { confirmReceipt, forwardConfirm } from "./handlers/confirm_receipt.ts";
import { notifySettle, settle } from "./handlers/settle.ts";

export const v1Registry: Registry = {
  // user-facing
  mint_promise: mintPromise,
  open_account: openAccount,
  propose_trade: proposeTrade,
  confirm_receipt: confirmReceipt,
  settle,                    // user (lead) triggers settle once confirmed
  // bank-to-bank
  approve_trade: approveTrade,
  hold,
  forward_confirm: forwardConfirm,
  notify_settle: notifySettle,
  // read-only
  get_promise: getPromise,
  get_account_balance: getAccountBalance,
  list_accounts: listAccounts,
};
