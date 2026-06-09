// Bank RPC method registry. Wired by the Edge Function entrypoint.
//
// The trade path is client-orchestrated (PROTOCOL.md §7): the proposing user
// calls create_records → propose_leg → hold_leg → settle_leg on each
// participating bank and relays signatures between them. Banks never call
// each other.

import type { Registry } from "./rpc.ts";
import { mintPromise } from "./handlers/mint_promise.ts";
import { openAccount } from "./handlers/open_account.ts";
import { getAccountBalance, getPromise, listAccounts } from "./handlers/get.ts";
import { createRecords } from "./handlers/create_records.ts";
import { proposeLeg } from "./handlers/propose_leg.ts";
import { holdLeg } from "./handlers/hold_leg.ts";
import { confirmReceipt } from "./handlers/confirm_receipt.ts";
import { settleLeg } from "./handlers/settle_leg.ts";
import { rejectLeg } from "./handlers/reject_leg.ts";

export const v1Registry: Registry = {
  // user-facing
  mint_promise: mintPromise,
  open_account: openAccount,
  // trade path — all called by the proposing client on each bank
  create_records: createRecords,
  propose_leg: proposeLeg,
  hold_leg: holdLeg,
  confirm_receipt: confirmReceipt,
  settle_leg: settleLeg,
  reject_leg: rejectLeg,
  // read-only
  get_promise: getPromise,
  get_account_balance: getAccountBalance,
  list_accounts: listAccounts,
};
