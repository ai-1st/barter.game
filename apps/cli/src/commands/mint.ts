// `barter mint <name> --amount N` — issue a Voucher on the user's home bank.
//
// Mint IS the first ledger record pair: the client authors the Voucher plus
// TWO Pocket/Account pairs locally (the issue account, which goes negative,
// and the holding account, which goes positive), and the bank settles the
// pair immediately. Pocket bodies never leave this machine — the bank only
// sees the two distinct pocket hashes inside the Account docs.

import {
  hashDoc,
  newUlid,
  signDoc,
} from "../../../../packages/protocol/src/index.ts";

import { call, fetchBankPubkey } from "../client.ts";
import { createLocalAccount } from "../docstore.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

type MintArgs = {
  name?: string;
  amount?: number;
  integer?: boolean;
  due?: string;
  limit?: number;
  bank?: string;
};

function parseArgs(argv: string[]): MintArgs {
  const args: MintArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--integer") args.integer = true;
    else if (a === "--amount") args.amount = Number(argv[++i]);
    else if (a === "--due") args.due = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--bank") args.bank = argv[++i];
    else if (!a.startsWith("--") && !args.name) args.name = a;
  }
  return args;
}

export async function runMint(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.name) {
    process.stderr.write(`barter mint: <name> is required (e.g. 'barter mint "1 logo" --amount 5')\n`);
    return 1;
  }
  const amount = args.amount ?? 1;
  if (!Number.isFinite(amount) || amount <= 0) {
    process.stderr.write(`barter mint: --amount must be a positive number\n`);
    return 1;
  }
  const profile = loadProfile();
  const bankUrl = args.bank ?? profile.defaultBankUrl;
  const bankPubkey = await fetchBankPubkey(bankUrl);

  const voucher: Record<string, unknown> = {
    type: "voucher",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    bank: bankPubkey,
    name: args.name,
  };
  if (args.integer !== undefined) voucher.integer = args.integer;
  if (args.due) voucher.due = args.due;
  if (args.limit !== undefined) voucher.limit = args.limit;
  voucher.sig = signDoc(voucher, profilePrivateKeyBytes(profile));

  // Two distinct pockets → two accounts: issue (negative) + holding (positive).
  const voucherHash = hashDoc(voucher);
  const issue = createLocalAccount(profile, voucherHash, "issue");
  const holding = createLocalAccount(profile, voucherHash, "holding");

  const result = (await call(
    profile,
    "mint",
    { voucher, debit_account: issue.account, credit_account: holding.account, amount },
    { bankUrl, toBankPubkey: bankPubkey },
  )) as {
    voucher_hash: string;
    debit_account_hash: string;
    credit_account_hash: string;
  };

  process.stdout.write(
    `minted ${amount} × "${args.name}"\n` +
      `  voucher hash:     ${result.voucher_hash}\n` +
      `  issue account:    ${result.debit_account_hash}  (balance −${amount})\n` +
      `  holding account:  ${result.credit_account_hash}  (balance +${amount})\n` +
      `  bank:             ${bankPubkey}\n` +
      `\n` +
      `share the voucher hash with others; they trade against your holding account.\n` +
      `offer a swap with 'barter invite'.\n`,
  );
  return 0;
}
