// `barter trade --invite "<string>"` — initiate the bilateral swap.
//
// The initiator (say Alice) verifies the inviter's signed offer, resolves
// her own two accounts (funded give account at her bank; fresh receiving
// account for the inviter's promise), creates the record pairs on both
// banks, cross-subscribes the banks, signs her own Tx as "lead", and prints
// the DEAL TOKEN the inviter must `barter accept` to follow-sign. From
// there the banks settle on their own.

import {
  isInviteExpired,
  parseInvite,
  verifyInvite,
  type DealSpec,
} from "../../../../packages/protocol/src/index.ts";
import { call, fetchBankPubkey } from "../client.ts";
import { createLocalAccount } from "../docstore.ts";
import { loadProfile } from "../profile.ts";
import { createRecordsAndLead, makeDealTokens, type BankMap } from "../orchestrate.ts";
import { saveDealState } from "../dealstate.ts";

type TradeArgs = { invite?: string; bank?: string; giveAccount?: string };

function parseArgs(argv: string[]): TradeArgs {
  const args: TradeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--invite": args.invite = argv[++i]; break;
      case "--bank": args.bank = argv[++i]; break;
      case "--give-account": args.giveAccount = argv[++i]; break;
    }
  }
  return args;
}

export async function runTrade(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.invite) {
    process.stderr.write(`barter trade: --invite "<barter://...>" required\n`);
    return 1;
  }
  const invite = parseInvite(args.invite);
  if (!verifyInvite(invite)) {
    process.stderr.write(`barter trade: invite signature does not verify — refusing\n`);
    return 1;
  }
  if (isInviteExpired(invite)) {
    process.stderr.write(`barter trade: invite expired\n`);
    return 1;
  }

  const profile = loadProfile();
  const myBankUrl = args.bank ?? profile.defaultBankUrl;
  const myBankPubkey = await fetchBankPubkey(myBankUrl);
  const peerBankPubkey = await fetchBankPubkey(invite.bankUrl);

  // The inviter's "get" is what I give; their "give" is what I get.
  const iGive = invite.get;
  const iGet = invite.give;

  // My funded account for the promise I give (it lives at MY bank).
  let myGiveAccount = args.giveAccount;
  if (!myGiveAccount) {
    const res = (await call(profile, "list_accounts", {}, { bankUrl: myBankUrl })) as {
      accounts: Array<{ account_hash: string; promise_hash: string; balance: string }>;
    };
    const funded = res.accounts.find(
      (a) => a.promise_hash === iGive.promise && Number(a.balance) >= iGive.amount,
    );
    if (!funded) {
      process.stderr.write(
        `barter trade: no account with ≥${iGive.amount} of ${iGive.promise} at ${myBankUrl} — pass --give-account\n`,
      );
      return 1;
    }
    myGiveAccount = funded.account_hash;
  }

  // My receiving account for the inviter's promise (implicit, authored now).
  const receiving = createLocalAccount(profile, iGet.promise, "main");

  const spec: DealSpec = {
    initiator: profile.pubkey,
    transfers: [
      {
        promise: iGive.promise, issuerBank: myBankPubkey, amount: iGive.amount,
        from: { holder: profile.pubkey, account: myGiveAccount },
        to: { holder: invite.pubkey, account: iGive.account },
      },
      {
        promise: iGet.promise, issuerBank: peerBankPubkey, amount: iGet.amount,
        from: { holder: invite.pubkey, account: iGet.account },
        to: { holder: profile.pubkey, account: receiving.accountHash },
      },
    ],
  };
  const banks: BankMap = { [myBankPubkey]: myBankUrl, [peerBankPubkey]: invite.bankUrl };

  // Present the inviter's bundled Account docs + my fresh receiving account
  // to the banks that need them (accounts are implicit).
  const inviterDocs = invite.accounts ?? [];
  const docsByBank: Record<string, Array<Record<string, unknown>>> = {
    [myBankPubkey]: inviterDocs.filter((d) => d.promise === iGive.promise),
    [peerBankPubkey]: [
      receiving.account,
      ...inviterDocs.filter((d) => d.promise === iGet.promise),
    ],
  };

  const state = await createRecordsAndLead(profile, spec, banks, docsByBank);
  const path = saveDealState(state);
  const tokens = makeDealTokens(profile, state);

  let out =
    `trade initiated — records created, your Tx lead-signed on both banks\n` +
    `  deal:        ${state.deal}\n` +
    `  lead bank:   ${myBankPubkey}\n` +
    `  state saved: ${path}\n\n` +
    `send the deal token to your counterparty; they run 'barter accept "<token>"':\n\n`;
  for (const t of tokens) {
    out += `token ${t.holder} ${t.token}\n\n`;
  }
  out +=
    `the banks settle on their own once everyone has signed.\n` +
    `watch with:   barter status ${state.deal}\n` +
    `if stalled:   barter nudge ${state.deal}\n`;
  process.stdout.write(out);
  return 0;
}
