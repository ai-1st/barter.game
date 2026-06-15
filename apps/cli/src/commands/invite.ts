// `barter invite --give <voucher>:N --get <voucher>:N` — offer a swap.
//
// The inviter (say Bob) names what he gives and what he wants, and bundles
// the two Account docs the deal will touch on his side: his funded account
// for the give voucher (resolved from his bank, or --give-account) and a
// freshly authored local account for the get voucher. The signed barter://
// string travels to the counterparty over any channel; she runs
// `barter trade --invite "<string>"`.

import {
  encodeInvite,
  signInvite,
  type Invite,
} from "../../../../packages/protocol/src/index.ts";

import { call } from "../client.ts";
import { createLocalAccount, listLocalDocs, loadLocalDoc } from "../docstore.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

type Leg = { voucher: string; amount: number };
type InviteArgs = {
  give?: Leg;
  get?: Leg;
  giveAccount?: string;
  bank?: string;
  exp?: number;
};

function parseLeg(raw: string | undefined, label: string): Leg {
  if (!raw) throw new Error(`--${label} <voucher-hash>:<amount> required`);
  const colon = raw.lastIndexOf(":");
  if (colon < 0) throw new Error(`--${label} must be <voucher-hash>:<amount>`);
  const amount = Number(raw.slice(colon + 1));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`--${label} amount must be positive`);
  return { voucher: raw.slice(0, colon), amount };
}

function parseArgs(argv: string[]): InviteArgs {
  const args: InviteArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--give": args.give = parseLeg(argv[++i], "give"); break;
      case "--get": args.get = parseLeg(argv[++i], "get"); break;
      case "--give-account": args.giveAccount = argv[++i]; break;
      case "--bank": args.bank = argv[++i]; break;
      case "--exp": args.exp = Number(argv[++i]); break;
    }
  }
  return args;
}

export async function runInvite(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.give || !args.get) {
    process.stderr.write(`barter invite: --give <voucher>:<amount> and --get <voucher>:<amount> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const bankUrl = args.bank ?? profile.defaultBankUrl;

  // Resolve my funded account for the give voucher at my bank.
  let giveAccount = args.giveAccount;
  if (!giveAccount) {
    const res = (await call(profile, "list_accounts", {}, { bankUrl })) as {
      accounts: Array<{ account_hash: string; voucher_hash: string; balance: string }>;
    };
    const funded = res.accounts.find(
      (a) => a.voucher_hash === args.give!.voucher && Number(a.balance) > 0,
    );
    if (!funded) {
      process.stderr.write(
        `barter invite: no funded account for ${args.give.voucher} at ${bankUrl} — pass --give-account\n`,
      );
      return 1;
    }
    giveAccount = funded.account_hash;
  }

  // Author my receiving account for the get voucher (offline, implicit).
  const receiving = createLocalAccount(profile, args.get.voucher, "main");

  // Bundle the account doc bodies so the initiator can present them to the
  // banks (accounts come into existence when shown).
  const accounts: Array<Record<string, unknown>> = [receiving.account];
  const giveBody = loadLocalDoc(giveAccount) ??
    listLocalDocs("account").find((d) => d.hash === giveAccount)?.body;
  if (giveBody) accounts.push(giveBody);

  const invite: Invite = {
    pubkey: profile.pubkey,
    bankUrl,
    give: { ...args.give, account: giveAccount },
    get: { ...args.get, account: receiving.accountHash },
    accounts,
    exp: Math.floor(Date.now() / 1000) + (args.exp ?? 7 * 24 * 3600),
  };
  const encoded = encodeInvite(signInvite(invite, profilePrivateKeyBytes(profile)));

  process.stdout.write(
    `invite created — send this string to your counterparty:\n\n${encoded}\n\n` +
      `they run:  barter trade --invite "<string>"\n`,
  );
  return 0;
}
