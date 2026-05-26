// `barter mint <name>` — issue a Promise on the user's home bank.
//
// Builds and signs the Promise doc client-side, sends to the bank via
// mint_promise RPC. Bank validates, stores, returns hashes + bank attestation.

import {
  hashDoc,
  newUlid,
  signDoc,
} from "../../../../packages/protocol/src/index.ts";

import { call, fetchBankPubkey } from "../client.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

type MintArgs = {
  name?: string;
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
    process.stderr.write(`barter mint: <name> is required (e.g. 'barter mint "1 logo"')\n`);
    return 1;
  }
  const profile = loadProfile();
  const bankUrl = args.bank ?? profile.defaultBankUrl;
  const bankPubkey = await fetchBankPubkey(bankUrl);

  const promise: Record<string, unknown> = {
    type: "promise",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    bank: bankPubkey,
    name: args.name,
  };
  if (args.integer !== undefined) promise.integer = args.integer;
  if (args.due) promise.due = args.due;
  if (args.limit !== undefined) promise.limit = args.limit;

  promise.sig = signDoc(promise, profilePrivateKeyBytes(profile));

  const result = (await call(profile, "mint_promise", { promise }, {
    bankUrl,
    toBankPubkey: bankPubkey,
  })) as {
    promise_hash: string;
    pocket_hash: string;
    account_hash: string;
    bank_attestation: Record<string, unknown>;
  };

  process.stdout.write(
    `minted "${args.name}"\n` +
      `  promise hash:   ${result.promise_hash}\n` +
      `  pocket hash:    ${result.pocket_hash}\n` +
      `  account hash:   ${result.account_hash}\n` +
      `  bank:           ${bankPubkey}\n` +
      `\n` +
      `share this promise with others by sending them the promise hash.\n` +
      `they can then propose a trade with you using 'barter trade'.\n`,
  );
  return 0;
}
