// `barter inbox` — list this user's accounts (with balances) on their home bank.

import { call } from "../client.ts";
import { loadProfile } from "../profile.ts";

type ListAccountsResult = {
  accounts: Array<{
    account_hash: string;
    promise_hash: string;
    pocket_hash: string;
    balance: string;
  }>;
  promises: Record<string, { name?: string; bank?: string }>;
};

export async function runInbox(argv: string[]): Promise<number> {
  let bankUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bank") bankUrl = argv[++i];
  }
  const profile = loadProfile();
  const url = bankUrl ?? profile.defaultBankUrl;
  const res = (await call(profile, "list_accounts", {}, { bankUrl: url })) as ListAccountsResult;

  if (res.accounts.length === 0) {
    process.stdout.write("inbox: no accounts on this bank yet.\n");
    return 0;
  }
  process.stdout.write(`accounts at ${url}:\n`);
  for (const a of res.accounts) {
    const p = res.promises[a.promise_hash];
    const promiseLabel = p?.name ? `"${p.name}"` : `(${a.promise_hash.slice(0, 12)}...)`;
    const bal = String(a.balance).padStart(6);
    process.stdout.write(
      `  ${promiseLabel.padEnd(22)} balance=${bal}\n` +
        `    account: ${a.account_hash}\n`,
    );
  }
  return 0;
}
