// `barter trade` — initiate a cross-bank trade.
//
// Usage:
//   barter trade \
//     --give <promise-hash>:<amount> --get <promise-hash>:<amount> \
//     --my-give-account <hash>   # my account at my bank (debited)
//     --peer-give-account <hash> # peer's account at my bank (credited)
//     --peer-get-account <hash>  # peer's account at peer bank (debited)
//     --my-get-account <hash>    # my account at peer bank (credited)
//     --peer-pubkey <pubkey>
//     --peer-bank <url>
//
// All 4 account hashes are explicit. v1.5 condenses this into a signed
// barter:// invite string.

import { call, fetchBankPubkey } from "../client.ts";
import { loadProfile } from "../profile.ts";

type Leg = { promise: string; amount: number };
type TradeArgs = {
  give?: Leg;
  get?: Leg;
  myGiveAccount?: string;
  peerGiveAccount?: string;
  peerGetAccount?: string;
  myGetAccount?: string;
  peerPubkey?: string;
  peerBank?: string;
  bank?: string;
};

function parseLeg(raw: string | undefined, label: string): Leg {
  if (!raw) throw new Error(`--${label} <promise-hash>:<amount> required`);
  const colon = raw.lastIndexOf(":");
  if (colon < 0) throw new Error(`--${label} must be <promise-hash>:<amount>`);
  const amount = Number(raw.slice(colon + 1));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`--${label} amount must be positive`);
  }
  return { promise: raw.slice(0, colon), amount };
}

function parseArgs(argv: string[]): TradeArgs {
  const args: TradeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--give": args.give = parseLeg(argv[++i], "give"); break;
      case "--get": args.get = parseLeg(argv[++i], "get"); break;
      case "--my-give-account": args.myGiveAccount = argv[++i]; break;
      case "--peer-give-account": args.peerGiveAccount = argv[++i]; break;
      case "--peer-get-account": args.peerGetAccount = argv[++i]; break;
      case "--my-get-account": args.myGetAccount = argv[++i]; break;
      case "--peer-pubkey": args.peerPubkey = argv[++i]; break;
      case "--peer-bank": args.peerBank = argv[++i]; break;
      case "--bank": args.bank = argv[++i]; break;
    }
  }
  return args;
}

const REQUIRED: Array<keyof TradeArgs> = [
  "give", "get", "myGiveAccount", "peerGiveAccount", "peerGetAccount",
  "myGetAccount", "peerPubkey", "peerBank",
];

export async function runTrade(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  for (const k of REQUIRED) {
    if (!args[k]) {
      const flag = "--" + (k as string).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
      process.stderr.write(`barter trade: ${flag} required\n`);
      return 1;
    }
  }
  const profile = loadProfile();
  const myBankUrl = args.bank ?? profile.defaultBankUrl;
  const myBankPubkey = await fetchBankPubkey(myBankUrl);
  const peerBankPubkey = await fetchBankPubkey(args.peerBank!);

  const result = (await call(
    profile,
    "propose_trade",
    {
      give: {
        promise_hash: args.give!.promise,
        amount: args.give!.amount,
        sender_account_hash: args.myGiveAccount,
        peer_account_hash: args.peerGiveAccount,
        issuer_bank_url: myBankUrl,
        issuer_bank_pubkey: myBankPubkey,
      },
      get: {
        promise_hash: args.get!.promise,
        amount: args.get!.amount,
        sender_account_hash: args.myGetAccount,
        peer_account_hash: args.peerGetAccount,
        issuer_bank_url: args.peerBank,
        issuer_bank_pubkey: peerBankPubkey,
      },
      peer_pubkey: args.peerPubkey,
      lead_bank_url: myBankUrl,
    },
    { bankUrl: myBankUrl, toBankPubkey: myBankPubkey },
  )) as { tx_hash: string; state: string; lead_bank: string; follow_bank: string };

  process.stdout.write(
    `trade proposed and held on both banks\n` +
      `  tx hash:      ${result.tx_hash}\n` +
      `  state:        ${result.state}\n` +
      `  lead bank:    ${result.lead_bank}\n` +
      `  follow bank:  ${result.follow_bank}\n` +
      `\nboth parties must now confirm receipt:\n` +
      `  you:    barter confirm ${result.tx_hash}\n` +
      `  peer:   barter confirm ${result.tx_hash}   (against their own bank)\n`,
  );
  return 0;
}
