// `barter init` — create or rotate the local profile.
//
// Usage:
//   barter init --bank <url>           Create a fresh profile.
//   barter init --bank <url> --force   Overwrite an existing profile.

import { existsSync } from "node:fs";
import { createProfile, profilePath } from "../profile.ts";

type InitArgs = { bank?: string; force?: boolean };

function parseArgs(argv: string[]): InitArgs {
  const args: InitArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bank") args.bank = argv[++i];
    else if (a === "--force") args.force = true;
  }
  return args;
}

export function runInit(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.bank) {
    process.stderr.write("barter init: --bank <url> is required\n");
    return 1;
  }
  const path = profilePath();
  if (existsSync(path) && !args.force) {
    process.stderr.write(
      `barter init: profile already exists at ${path}. Re-run with --force to overwrite.\n`,
    );
    return 1;
  }
  const profile = createProfile({ bankUrl: args.bank });
  process.stdout.write(
    `created profile at ${path}\n` +
      `pubkey:        ${profile.pubkey}\n` +
      `default bank:  ${profile.defaultBankUrl}\n` +
      `\n` +
      `WARNING: profile.privateKey is plaintext in v1. Encryption is v1.5+.\n`,
  );
  return 0;
}
