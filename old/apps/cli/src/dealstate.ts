// Local persistence for the initiator's in-flight deal, so `barter status`
// and `barter nudge` can watch / un-stick it after the other holders accept
// out of band. Stored next to the profile, keyed by the deal ULID.

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
  const path = join(dir, `${state.deal}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  return path;
}

export function loadDealState(deal: string): DealState {
  const path = join(dealsDir(), `${deal}.json`);
  if (!existsSync(path)) {
    throw new Error(`no local deal state for ${deal} at ${path}; only the initiator tracks a deal`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as DealState;
}
