#!/usr/bin/env bun
// barter.game CLI.

import { runInit } from "./commands/init.ts";
import { runMint } from "./commands/mint.ts";

const VERSION = "0.0.2-w2";

const HELP = `barter — federated mutual-credit ledger CLI (v${VERSION})

USAGE:
  barter <command> [options]

COMMANDS:
  init --bank <url>       Create or rotate local profile (~/.barter/profile.json).
  mint <name>             Issue a Promise on your home bank.
                            --integer        only integer amounts
                            --due YYYY-MM-DD optional maturity date
                            --limit N        max supply
                            --bank <url>     override default bank
  open <promise-hash>     Open an Account for someone else's Promise.        (W3)
  trade <invite>          Accept a barter:// invite and run the trade.       (W3)
  inbox                   List pending Txs on your home bank.                (W3)
  confirm <tx-hash>       Sign confirm_receipt for a Tx.                     (W4)
  doctor <bank-url>       Health-check a bank end-to-end.                    (W4)

OPTIONS:
  -h, --help              Show this help.
  -v, --version           Show CLI version.

ENVIRONMENT:
  BARTER_PROFILE          Path to profile file (default: ~/.barter/profile.json)

DESIGN DOC:
  ~/.gstack/projects/barter.game/xo-main-design-20260526-145322.md
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
      case "init":
        return runInit(rest);
      case "mint":
        return await runMint(rest);
      case "open":
      case "trade":
      case "inbox":
      case "confirm":
      case "doctor":
        process.stderr.write(
          `barter: '${cmd}' lands in a later weekend per the design doc.\n`,
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
