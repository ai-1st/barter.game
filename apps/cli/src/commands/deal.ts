// `barter deal <deal-file.json>` — initiate an N-party deal.
//
// The initiating user is the coordinator: it builds the whole deal, hands
// each bank only its own slice, cross-subscribes the banks, and lead-signs
// its own Tx. The command prints one deal token per other holder; each
// runs `barter accept "<token>"` to follow-sign, and the banks settle on
// their own from there.
//
// Deal file shape:
// {
//   "leadBanks": ["<bankPubkey>", ...],          // banks that settle first
//   "banks": { "<bankPubkey>": "<rpc-url>", ... },
//   "transfers": [
//     { "voucher": "<hash>", "issuerBank": "<bankPubkey>", "amount": 1,
//       "from": { "holder": "<pubkey>", "account": "<hash>" },
//       "to":   { "holder": "<pubkey>", "account": "<hash>" } }
//   ],
//   "docs": { "<bankPubkey>": [ <Voucher/Account doc bodies> ] }   // optional
// }
//
// Account docs referenced by the transfers and present in the local doc
// store are attached automatically (accounts are implicit).

import { readFileSync } from "node:fs";

import { hashDoc, type DealSpec, type TransferSpec } from "../../../../packages/protocol/src/index.ts";
import { listLocalDocs } from "../docstore.ts";
import { loadProfile } from "../profile.ts";
import { createRecordsAndLead, makeDealTokens, type BankMap } from "../orchestrate.ts";
import { saveDealState } from "../dealstate.ts";

type DealFile = {
  banks?: BankMap;
  transfers?: TransferSpec[];
  docs?: Record<string, Array<Record<string, unknown>>>;
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
    initiator: profile.pubkey,
    transfers: parsed.transfers,
  };

  // Attach docs: explicit per-bank docs from the file, plus any locally
  // stored Account docs matching the transfers' account hashes.
  const local = listLocalDocs("account");
  const docsByBank: Record<string, Array<Record<string, unknown>>> = { ...(parsed.docs ?? {}) };
  for (const t of parsed.transfers) {
    for (const accountHash of [t.from.account, t.to.account]) {
      const found = local.find((d) => d.hash === accountHash);
      if (!found) continue;
      if (!docsByBank[t.issuerBank]) docsByBank[t.issuerBank] = [];
      const bucket = docsByBank[t.issuerBank]!;
      if (!bucket.some((d) => hashDoc(d) === found.hash)) {
        bucket.push(found.body);
      }
    }
  }

  const state = await createRecordsAndLead(profile, spec, banks, docsByBank);
  const path = saveDealState(state);
  const tokens = makeDealTokens(profile, state);

  let out =
    `deal initiated across ${state.order.length} bank(s)\n` +
    `  deal:         ${state.deal}\n` +
    `  settle order: ${state.order.join(" → ")}\n` +
    `  state saved:  ${path}\n\n` +
    `send each holder their deal token; they run 'barter accept "<token>"':\n\n`;
  for (const t of tokens) {
    out += `token ${t.holder} ${t.token}\n\n`;
  }
  out +=
    `the banks settle on their own once everyone has signed.\n` +
    `watch with:   barter status ${state.deal}\n` +
    `if stalled:   barter nudge ${state.deal}\n`;
  process.stdout.write(out);
  return 0;
}
