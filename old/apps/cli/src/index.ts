#!/usr/bin/env bun
// barter.game CLI.

import { runAccept } from "./commands/accept.ts";
import { runAccount } from "./commands/account.ts";
import { runDeal } from "./commands/deal.ts";
import { runInbox } from "./commands/inbox.ts";
import { runInit } from "./commands/init.ts";
import { runInvite } from "./commands/invite.ts";
import { runMint } from "./commands/mint.ts";
import { runNudge } from "./commands/nudge.ts";
import { runStatus } from "./commands/status.ts";
import { runSubscribe } from "./commands/subscribe.ts";
import { runTrade } from "./commands/trade.ts";

const VERSION = "0.0.5-direct-approval";

const HELP = `barter — federated mutual-credit ledger CLI (v${VERSION})

USAGE:
  barter <command> [options]

COMMANDS:
  init --bank <url>
      Create or rotate the local profile (~/.barter/profile.json).

  mint <name> --amount N [--integer] [--due YYYY-MM-DD] [--limit N]
      Issue a Voucher: the mint is the first debit/credit record pair
      (issue account goes negative, holding account positive).

  account <voucher-hash> [--name <account-name>]
      Author a receiving Account locally. No bank call — accounts are
      implicit and come into existence when the doc is first presented.

  invite --give <voucher>:N --get <voucher>:N [--give-account <hash>]
      Offer a swap. Prints a signed barter:// string for the counterparty.

  trade --invite "<barter://...>"
      Initiate the swap from an invite: create records on both banks,
      lead-sign your Tx, print the deal token the inviter must accept.

  deal <deal-file.json>
      Initiate an N-party deal (any number of banks/holders). Prints one
      deal token per other holder.

  accept "<deal-token>"
      Follow-sign your view of a deal. Banks settle on their own after.

  status <deal-ulid>
      Watch a deal you initiated (per-bank leg states).

  nudge <deal-ulid>
      Relay signatures between banks by hand to un-stick a stalled deal.

  subscribe --bank <url> --url <push-url> --hash <h>...
      Register a standing signature fan-out at a bank.

  inbox [--bank <url>]
      List your accounts (with balances) on a bank.

OPTIONS:
  -h, --help              Show this help.
  -v, --version           Show CLI version.
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "-v" || args[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case "init":      return runInit(rest);
      case "mint":      return await runMint(rest);
      case "account":   return runAccount(rest);
      case "invite":    return await runInvite(rest);
      case "trade":     return await runTrade(rest);
      case "deal":      return await runDeal(rest);
      case "accept":    return await runAccept(rest);
      case "status":    return await runStatus(rest);
      case "nudge":     return await runNudge(rest);
      case "subscribe": return await runSubscribe(rest);
      case "inbox":     return await runInbox(rest);
      case "open":
      case "confirm":
      case "settle":
        process.stderr.write(
          `barter: '${cmd}' was removed in the direct-approval model.\n` +
            `  open    → 'barter account' (accounts are implicit; no bank call)\n` +
            `  confirm → 'barter accept' (you sign your own Tx as follow)\n` +
            `  settle  → banks settle on their own; see 'barter status' / 'barter nudge'\n`,
        );
        return 2;
      default:
        process.stderr.write(`barter: unknown command '${cmd}'. Try 'barter --help'.\n`);
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`barter: error — ${msg}\n`);
    return 1;
  }
}

const code = await main(process.argv);
process.exit(code);
