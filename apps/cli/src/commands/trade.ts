// `barter trade` — bilateral convenience over the N-party orchestrator.
//
// A two-transfer deal (I give X at my bank, I get Y at the peer bank) with my
// bank as the lead. Builds it as a DealSpec and runs the same propose → hold
// flow as `barter deal`; settle/confirm work identically afterward.
//
// Usage:
//   barter trade \
//     --give <promise-hash>:<amount> --get <promise-hash>:<amount> \
//     --my-give-account <h> --peer-give-account <h> \
//     --peer-get-account <h> --my-get-account <h> \
//     --peer-pubkey <pubkey> --peer-bank <url> [--bank <my-bank-url>]

import type { DealSpec } from "../../../../packages/protocol/src/index.ts";
import { fetchBankPubkey } from "../client.ts";
import { loadProfile } from "../profile.ts";
import { proposeAndHold, type BankMap } from "../orchestrate.ts";
import { saveDealState } from "../dealstate.ts";

type Leg = { promise: string; amount: number };
type TradeArgs = {
  give?: Leg; get?: Leg;
  myGiveAccount?: string; peerGiveAccount?: string;
  peerGetAccount?: string; myGetAccount?: string;
  peerPubkey?: string; peerBank?: string; bank?: string;
};

function parseLeg(raw: string | undefined, label: string): Leg {
  if (!raw) throw new Error(`--${label} <promise-hash>:<amount> required`);
  const colon = raw.lastIndexOf(":");
  if (colon < 0) throw new Error(`--${label} must be <promise-hash>:<amount>`);
  const amount = Number(raw.slice(colon + 1));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`--${label} amount must be positive`);
  return { promise: raw.slice(0, colon), amount };
}

function parseArgs(argv: string[]): TradeArgs {
  const args: TradeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
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
  "give", "get", "myGiveAccount", "peerGiveAccount", "peerGetAccount", "myGetAccount", "peerPubkey", "peerBank",
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

  const spec: DealSpec = {
    proposer: profile.pubkey,
    leadBanks: [myBankPubkey],
    transfers: [
      {
        promise: args.give!.promise, issuerBank: myBankPubkey, amount: args.give!.amount,
        from: { holder: profile.pubkey, account: args.myGiveAccount! },
        to: { holder: args.peerPubkey!, account: args.peerGiveAccount! },
      },
      {
        promise: args.get!.promise, issuerBank: peerBankPubkey, amount: args.get!.amount,
        from: { holder: args.peerPubkey!, account: args.peerGetAccount! },
        to: { holder: profile.pubkey, account: args.myGetAccount! },
      },
    ],
  };
  const banks: BankMap = { [myBankPubkey]: myBankUrl, [peerBankPubkey]: args.peerBank! };

  const state = await proposeAndHold(profile, spec, banks);
  saveDealState(state);

  process.stdout.write(
    `trade proposed + held on both banks\n` +
      `  tx hash:      ${state.txHash}\n` +
      `  lead bank:    ${myBankPubkey}\n` +
      `  follow bank:  ${peerBankPubkey}\n\n` +
      `both parties confirm receipt at BOTH banks, then you settle:\n` +
      `  you:   barter confirm ${state.txHash} --bank ${myBankUrl} --bank ${args.peerBank}\n` +
      `  peer:  barter confirm ${state.txHash} --bank ${myBankUrl} --bank ${args.peerBank}\n` +
      `  then:  barter settle ${state.txHash}\n`,
  );
  return 0;
}
