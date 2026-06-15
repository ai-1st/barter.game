// `barter accept "<deal-token>"` — follow-sign your view of a deal.
//
// The counterparty verifies the initiator's token, re-fetches the records
// from each bank (a token can't lie about bank-minted records —
// get_record_signatures is the source of truth), then signs THEIR OWN Tx with
// action "follow" and submits it to every bank in the token. That signature is
// both the authorization for their records and the receipt confirmation. The
// banks then advance to settled on their own.

import {
  hashDoc,
  parseDealToken,
  verifyDealToken,
} from "../../../../packages/protocol/src/index.ts";
import { call } from "../client.ts";
import { listLocalDocs } from "../docstore.ts";
import { loadProfile } from "../profile.ts";
import { submitFollow } from "../orchestrate.ts";

export async function runAccept(argv: string[]): Promise<number> {
  const raw = argv.find((a) => !a.startsWith("--"));
  if (!raw) {
    process.stderr.write(`barter accept: <deal-token> required\n`);
    return 1;
  }
  const token = parseDealToken(raw);
  if (!verifyDealToken(token)) {
    process.stderr.write(`barter accept: token signature does not verify — refusing\n`);
    return 1;
  }
  if (token.exp <= Math.floor(Date.now() / 1000)) {
    process.stderr.write(`barter accept: token expired\n`);
    return 1;
  }
  const profile = loadProfile();
  if (token.tx.pubkey !== profile.pubkey) {
    process.stderr.write(
      `barter accept: this token's Tx is for ${token.tx.pubkey}, not you (${profile.pubkey})\n`,
    );
    return 1;
  }

  // Don't trust the token's record bodies — verify against each bank.
  for (const bank of token.banks) {
    for (const claimed of token.records) {
      if (claimed.pubkey !== bank.pubkey) continue; // another bank's record
      const view = (await call(profile, "get_record_signatures", { record_hash: hashDoc(claimed) }, {
        bankUrl: bank.url,
        toBankPubkey: bank.pubkey,
      })) as { record: Record<string, unknown> };
      const real = view.record;
      if (
        !real || real.amount !== claimed.amount || real.account !== claimed.account ||
        real.type !== claimed.type
      ) {
        process.stderr.write(
          `barter accept: record ${hashDoc(claimed)} does not match the bank's books — refusing\n`,
        );
        return 1;
      }
    }
  }

  // Attach my Account doc bodies for any of my accounts the records touch.
  // Each account must be presented ONLY to the bank that issued its promise;
  // a bank's intakeDocs rejects accounts referencing foreign promises.
  const myAccounts = new Set(
    token.records.map((r) => r.account).filter((a): a is string => typeof a === "string"),
  );
  const accountBank = new Map<string, string>();
  for (const r of token.records) {
    if (typeof r.account === "string" && typeof r.pubkey === "string") {
      accountBank.set(r.account, r.pubkey);
    }
  }
  const accountDocs = listLocalDocs("account").filter((d) => myAccounts.has(d.hash));
  const docsByBank: Record<string, Array<Record<string, unknown>>> = {};
  for (const d of accountDocs) {
    const bank = accountBank.get(d.hash);
    if (!bank) continue; // shouldn't happen: token.records told us the bank
    if (!docsByBank[bank]) docsByBank[bank] = [];
    docsByBank[bank]!.push(d.body);
  }

  await submitFollow(profile, token.tx, token.banks, docsByBank);

  process.stdout.write(
    `accepted — your Tx is follow-signed at ${token.banks.length} bank(s)\n` +
      `  deal:    ${token.deal}\n` +
      `  tx hash: ${hashDoc(token.tx)}\n\n` +
      `the banks settle on their own from here. Watch your balances with 'barter inbox'.\n`,
  );
  return 0;
}
