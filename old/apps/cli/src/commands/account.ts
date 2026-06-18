// `barter account <voucher-hash>` — author a receiving Account locally.
//
// Purely offline: accounts are implicit, so "opening" one is just writing a
// Account + Account doc into the local doc store. The Account body reaches
// the issuing bank the first time it is presented (inside an invite, a deal
// file, or create_records/submit_tx docs[]).

import { createLocalAccount } from "../docstore.ts";
import { loadProfile } from "../profile.ts";

export function runAccount(argv: string[]): number {
  const voucherHash = argv.find((a) => !a.startsWith("--"));
  let name = "main";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i] ?? "main";
  }
  if (!voucherHash) {
    process.stderr.write(`barter account: <voucher-hash> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const { accountHash, accountHash } = createLocalAccount(profile, voucherHash, name);
  process.stdout.write(
    `account created locally (no bank call — accounts are implicit)\n` +
      `  account hash: ${accountHash}\n` +
      `  account hash:  ${accountHash}  (account body stays on this machine)\n` +
      `  voucher:      ${voucherHash}\n`,
  );
  return 0;
}
