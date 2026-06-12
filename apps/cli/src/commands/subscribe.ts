// `barter subscribe` — register a standing signature fan-out at a bank.
//
// Normally `barter trade` / `barter deal` cross-subscribe the banks for you;
// this is the manual escape hatch (e.g. point a deal's signatures at your
// own webhook).
//
//   barter subscribe --bank <url> --url <push-url> \
//     [--deal <ulid>]... [--record <ulid>]... [--hash <h>]... \
//     [--to <pubkey>] [--until YYYY-MM-DD]

import { newUlid } from "../../../../packages/protocol/src/index.ts";
import { call } from "../client.ts";
import { loadProfile } from "../profile.ts";

export async function runSubscribe(argv: string[]): Promise<number> {
  const deals: string[] = [];
  const records: string[] = [];
  const hashes: string[] = [];
  let bank: string | undefined;
  let url: string | undefined;
  let to: string | undefined;
  let until: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--bank": bank = argv[++i]; break;
      case "--url": url = argv[++i]; break;
      case "--deal": deals.push(argv[++i]); break;
      case "--record": records.push(argv[++i]); break;
      case "--hash": hashes.push(argv[++i]); break;
      case "--to": to = argv[++i]; break;
      case "--until": until = argv[++i]; break;
    }
  }
  if (!url || deals.length + records.length + hashes.length === 0) {
    process.stderr.write(`barter subscribe: --url and at least one --deal/--record/--hash required\n`);
    return 1;
  }
  const profile = loadProfile();

  const subscription: Record<string, unknown> = {
    type: "subscription",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    url,
  };
  if (deals.length) subscription.deals = deals;
  if (records.length) subscription.records = records;
  if (hashes.length) subscription.hashes = hashes;
  if (to) subscription.to = to;
  if (until) subscription.until = until;

  const res = (await call(profile, "subscribe", { subscription }, { bankUrl: bank })) as {
    subscription_hash: string;
    watching: number;
    until: string;
  };
  process.stdout.write(
    `subscribed\n  hash:     ${res.subscription_hash}\n  watching: ${res.watching} key(s)\n  until:    ${res.until}\n`,
  );
  return 0;
}
