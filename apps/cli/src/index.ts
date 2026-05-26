#!/usr/bin/env bun
// barter.game CLI.

import { runConfirm } from "./commands/confirm.ts";
import { runInbox } from "./commands/inbox.ts";
import { runInit } from "./commands/init.ts";
import { runMint } from "./commands/mint.ts";
import { runOpen } from "./commands/open.ts";
import { runSettle } from "./commands/settle.ts";
import { runTrade } from "./commands/trade.ts";

const VERSION = "0.0.3-w3";

const HELP = `barter — federated mutual-credit ledger CLI (v${VERSION})

USAGE:
  barter <command> [options]

COMMANDS:
  init --bank <url>
      Create or rotate the local profile (~/.barter/profile.json).

  mint <name> [--integer] [--due YYYY-MM-DD] [--limit N]
      Issue a Promise on your home bank.

  open <promise-hash> --bank <url> [--pocket <hash>]
      Pre-create an Account for someone else's Promise on the issuing bank.

  trade --give <hash>:N --get <hash>:N \\
        --my-give-account <h> --peer-give-account <h> \\
        --peer-get-account <h> --my-get-account <h> \\
        --peer-pubkey <pubkey> --peer-bank <url>
      Initiate a cross-bank trade. Lead bank locks both accounts.

  inbox [--bank <url>]
      List your accounts (with balances) on a bank.

  confirm <tx-hash> [--bank <url>]
      Sign confirm_receipt for a held Tx.

  settle <tx-hash> [--bank <url>]
      Lead user triggers settlement once both parties confirmed.

  doctor <bank-url>
      Health-check a bank end-to-end.                            (W4)

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
      case "init":     return runInit(rest);
      case "mint":     return await runMint(rest);
      case "open":     return await runOpen(rest);
      case "trade":    return await runTrade(rest);
      case "inbox":    return await runInbox(rest);
      case "confirm":  return await runConfirm(rest);
      case "settle":   return await runSettle(rest);
      case "doctor":
        process.stderr.write(`barter: '${cmd}' lands in W4.\n`);
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
