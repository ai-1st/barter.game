// `barter nudge <deal>` — un-stick a stalled deal by relaying signatures.
//
// Subscription pushes are fire-and-forget; if one is lost a bank may sit
// waiting for a peer signature it never received. Signatures carry their
// own authority, so the client can deliver them by hand: read every bank's
// signatures (get_session) and notify every other bank. Each delivery
// re-evaluates the advance engine.

import { loadProfile } from "../profile.ts";
import { fetchLegStates, relayAll } from "../orchestrate.ts";
import { loadDealState } from "../dealstate.ts";

export async function runNudge(argv: string[]): Promise<number> {
  const deal = argv.find((a) => !a.startsWith("--"));
  if (!deal) {
    process.stderr.write(`barter nudge: <deal-ulid> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const state = loadDealState(deal);

  await relayAll(profile, state);

  const legs = await fetchLegStates(profile, state);
  let out = `relayed signatures across ${state.order.length} bank(s)\n`;
  for (const l of legs) {
    out += `  ${l.bank.slice(0, 12)}…  ${l.state}\n`;
  }
  process.stdout.write(out);
  return 0;
}
