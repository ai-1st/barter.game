// `barter settle <tx-hash>` — the proposer drives the settle cascade.
//
// Reads the locally-saved deal state (written by `barter deal` / `barter
// trade`), then calls settle_leg on each bank in topological order, relaying
// each bank's settle signature to its downstream followers. Only the proposer
// has the deal state, so only the proposer can settle.

import { loadProfile } from "../profile.ts";
import { settleCascade } from "../orchestrate.ts";
import { loadDealState } from "../dealstate.ts";

export async function runSettle(argv: string[]): Promise<number> {
  const txHash = argv.find((a) => !a.startsWith("--"));
  if (!txHash) {
    process.stderr.write(`barter settle: <tx-hash> required\n`);
    return 1;
  }
  const profile = loadProfile();

  let state;
  try {
    state = loadDealState(txHash);
  } catch (err) {
    process.stderr.write(`barter settle: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const results = await settleCascade(profile, state);

  let out = `settle cascade for ${txHash}\n`;
  for (const r of results) {
    out += `  ${r.bank.slice(0, 12)}…  ${r.state}\n`;
  }
  out += `\nall legs settled in order: ${state.order.join(" → ")}\n`;
  process.stdout.write(out);
  return 0;
}
