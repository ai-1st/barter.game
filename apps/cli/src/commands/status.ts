// `barter status <deal>` — watch a deal the local profile initiated.
//
// Banks self-advance; the client just observes. Reads the locally-saved
// deal state and polls get_session on every participating bank.

import { loadProfile } from "../profile.ts";
import { fetchLegStates } from "../orchestrate.ts";
import { loadDealState } from "../dealstate.ts";

export async function runStatus(argv: string[]): Promise<number> {
  const deal = argv.find((a) => !a.startsWith("--"));
  if (!deal) {
    process.stderr.write(`barter status: <deal-ulid> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const state = loadDealState(deal);
  const legs = await fetchLegStates(profile, state);

  let out = `deal ${deal}\n`;
  let allSettled = true;
  for (const l of legs) {
    out += `  ${l.bank.slice(0, 12)}…  ${l.state}\n`;
    if (l.state !== "settled") allSettled = false;
  }
  out += allSettled
    ? `\nall legs settled.\n`
    : `\nnot settled everywhere yet — banks advance as signatures arrive; 'barter nudge ${deal}' relays by hand.\n`;
  process.stdout.write(out);
  return allSettled ? 0 : 3;
}
