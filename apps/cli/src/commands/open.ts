// `barter open <promise-hash> --bank <url>` — pre-create an Account on the
// issuing bank for someone else's Promise. Required before any incoming
// transfer of that Promise can settle into your balance.

import {
  hashDoc,
  newUlid,
  signDoc,
} from "../../../../packages/protocol/src/index.ts";

import { call, fetchBankPubkey } from "../client.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

type OpenArgs = { promise?: string; bank?: string; pocket?: string };

function parseArgs(argv: string[]): OpenArgs {
  const args: OpenArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--bank") args.bank = argv[++i];
    else if (a === "--pocket") args.pocket = argv[++i];
    else if (!a.startsWith("--") && !args.promise) args.promise = a;
  }
  return args;
}

export async function runOpen(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.promise) {
    process.stderr.write(`barter open: <promise-hash> required\n`);
    return 1;
  }
  if (!args.bank) {
    process.stderr.write(`barter open: --bank <url> required (the bank that issued the promise)\n`);
    return 1;
  }
  const profile = loadProfile();
  const issuerBankUrl = args.bank;
  const issuerBankPubkey = await fetchBankPubkey(issuerBankUrl);

  // Verify the Promise exists at the issuer bank.
  const { promise } = (await call(profile, "get_promise", { promise_hash: args.promise }, {
    bankUrl: issuerBankUrl,
    toBankPubkey: issuerBankPubkey,
  })) as { promise: Record<string, unknown> };

  if (promise.bank !== issuerBankPubkey) {
    process.stderr.write(
      `barter open: promise.bank (${String(promise.bank)}) does not match --bank pubkey (${issuerBankPubkey})\n`,
    );
    return 1;
  }

  // Build the holder's Pocket (or reuse a supplied hash).
  let pocketHash: string;
  let pocketDoc: Record<string, unknown> | undefined;
  if (args.pocket) {
    pocketHash = args.pocket;
  } else {
    pocketDoc = {
      type: "pocket",
      pubkey: profile.pubkey,
      ulid: newUlid(),
      name: `holding ${(promise.name as string) ?? "promise"}`,
    };
    pocketHash = hashDoc(pocketDoc);
  }

  const accountDoc: Record<string, unknown> = {
    type: "account",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    pocket: pocketHash,
    promise: args.promise,
  };
  accountDoc.sig = signDoc(accountDoc, profilePrivateKeyBytes(profile));

  const result = (await call(
    profile,
    "open_account",
    pocketDoc ? { account: accountDoc, pocket: pocketDoc } : { account: accountDoc },
    { bankUrl: issuerBankUrl, toBankPubkey: issuerBankPubkey },
  )) as {
    account_hash: string;
    promise_hash: string;
    pocket_hash: string;
    bank: string;
  };

  process.stdout.write(
    `opened account for "${promise.name as string}"\n` +
      `  account hash:  ${result.account_hash}\n` +
      `  promise hash:  ${result.promise_hash}\n` +
      `  pocket hash:   ${result.pocket_hash}\n` +
      `  at bank:       ${result.bank}\n`,
  );
  return 0;
}
