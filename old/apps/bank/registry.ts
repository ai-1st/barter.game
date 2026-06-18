// Bank RPC method registry. Wired by main.ts.
//
// Direct approval (PROTOCOL.md §2): the initiating client creates the
// records on each bank (create_records), each holder submits their own
// signed Tx (submit_tx, relayable by anyone), and from there the banks
// self-advance through hold and settle — observing each other's signatures
// via subscription fan-out (subscribe / notify_signatures) or client relay.
// There is no client-driven hold/settle call.

import type { Registry } from "./rpc.ts";
import { mintVoucher } from "./handlers/mint_voucher.ts";
import { createRecords } from "./handlers/create_records.ts";
import { submitTx } from "./handlers/submit_tx.ts";
import { subscribe } from "./handlers/subscribe.ts";
import { notifySignatures } from "./handlers/notify_signatures.ts";
import { getRecordSignatures } from "./handlers/get_record_signatures.ts";
import { getAccountBalance, getVoucher, listAccounts } from "./handlers/get.ts";

export const v1Registry: Registry = {
  // issuance — mint IS the first record pair, settled immediately
  mint: mintVoucher,
  // trade path (wave 1 — direct approval)
  create_records: createRecords,
  submit_tx: submitTx,
  // signature fan-out (waves 2-3 run inside the banks; these feed them)
  subscribe: subscribe,
  notify_signatures: notifySignatures,
  // read-only
  get_record_signatures: getRecordSignatures,
  get_voucher: getVoucher,
  get_account_balance: getAccountBalance,
  list_accounts: listAccounts,
};
