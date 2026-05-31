// `barter deal <deal-file.json>` — propose an N-party deal.
//
// The proposing user is the coordinator: it builds the whole deal, hands each
// bank only its own slice, and locks every leg. Then each holder confirms (out
// of band), and the proposer runs `barter settle <tx>` to drive the cascade.
//
// Deal file shape:
// {
//   "leadBanks": ["<bankPubkey>", ...],          // banks that settle first
//   "banks": { "<bankPubkey>": "<rpc-url>", ... },
//   "transfers": [
//     { "promise": "<hash>", "issuerBank": "<bankPubkey>", "amount": 1,
//       "from": { "holder": "<pubkey>", "account": "<hash>" },
//       "to":   { "holder": "<pubkey>", "account": "<hash>" } }
//   ]
// }

import { readFileSync } from "node:fs";

import type { DealSpec, TransferSpec } from "../../../../packages/protocol/src/index.ts";
import { loadProfile } from "../profile.ts";
import { proposeAndHold, type BankMap } from "../orchestrate.ts";
import { saveDealState } from "../dealstate.ts";

type DealFile = {
  leadBanks?: string[];
  banks?: BankMap;
  transfers?: TransferSpec[];
};

export async function runDeal(argv: string[]): Promise<number> {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    process.stderr.write(`barter deal: <deal-file.json> required\n`);
    return 1;
  }
  const profile = loadProfile();

  let parsed: DealFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as DealFile;
  } catch (err) {
    process.stderr.write(`barter deal: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!parsed.transfers || parsed.transfers.length === 0) {
    process.stderr.write(`barter deal: deal file needs a non-empty transfers[]\n`);
    return 1;
  }
  const banks = parsed.banks ?? {};
  for (const t of parsed.transfers) {
    if (!banks[t.issuerBank]) {
      process.stderr.write(`barter deal: no banks["${t.issuerBank}"] URL for an issuer bank in transfers\n`);
      return 1;
    }
  }

  const spec: DealSpec = {
    proposer: profile.pubkey,
    leadBanks: parsed.leadBanks ?? [],
    transfers: parsed.transfers,
  };

  const state = await proposeAndHold(profile, spec, banks);
  const path = saveDealState(state);

  let out =
    `deal proposed + held across ${state.order.length} bank(s)\n` +
    `  tx hash:      ${state.txHash}\n` +
    `  settle order: ${state.order.join(" → ")}\n` +
    `  state saved:  ${path}\n\n` +
    `each holder must now confirm receipt at every bank they touch:\n`;
  for (const [holder, holderBanks] of Object.entries(state.confirmsByHolder)) {
    const bankFlags = holderBanks.map((b) => `--bank ${state.banks[b]}`).join(" ");
    out += `  ${holder.slice(0, 12)}…  barter confirm ${state.txHash} ${bankFlags}\n`;
  }
  out += `\nthen the proposer settles:\n  barter settle ${state.txHash}\n`;
  process.stdout.write(out);
  return 0;
}
