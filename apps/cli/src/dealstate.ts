// Local persistence for the proposer's in-flight deal, so `barter settle` can
// resume the settle cascade after holders confirm out of band. Stored next to
// the profile, keyed by Tx hash.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { profilePath } from "./profile.ts";
import type { DealState } from "./orchestrate.ts";

function dealsDir(): string {
  return join(dirname(profilePath()), "deals");
}

export function saveDealState(state: DealState): string {
  const dir = dealsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.txHash}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  return path;
}

export function loadDealState(txHash: string): DealState {
  const path = join(dealsDir(), `${txHash}.json`);
  if (!existsSync(path)) {
    throw new Error(`no local deal state for ${txHash} at ${path}; only the proposer can settle a deal`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as DealState;
}
