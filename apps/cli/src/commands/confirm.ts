// `barter confirm <tx-hash> --bank <url> [--bank <url> ...]`
//
// A holder signs ONE settle-action Signature over the Tx hash and posts it to
// every bank where they hold a record in the deal (banks don't forward it —
// they only see their own leg). The proposer's `barter deal` output prints the
// exact bank list for each holder.

import { newUlid, signDoc } from "../../../../packages/protocol/src/index.ts";
import { call } from "../client.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

export async function runConfirm(argv: string[]): Promise<number> {
  let txHash: string | undefined;
  const banks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bank") banks.push(argv[++i]!);
    else if (a && !a.startsWith("--") && !txHash) txHash = a;
  }
  if (!txHash) {
    process.stderr.write(`barter confirm: <tx-hash> required\n`);
    return 1;
  }
  const profile = loadProfile();
  if (banks.length === 0) banks.push(profile.defaultBankUrl);

  // One signature, delivered to every bank this holder touches.
  const confirmDoc: Record<string, unknown> = {
    type: "signature",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "settle",
  };
  confirmDoc.sig = signDoc(confirmDoc, profilePrivateKeyBytes(profile));

  for (const url of banks) {
    const result = (await call(
      profile,
      "confirm_receipt",
      { tx_hash: txHash, user_confirm: confirmDoc },
      { bankUrl: url },
    )) as { leg_confirmed?: boolean; note?: string };
    process.stdout.write(
      `confirmed at ${url}\n` +
        `  leg fully confirmed: ${result.leg_confirmed ?? false}\n` +
        (result.note ? `  ${result.note}\n` : ""),
    );
  }
  return 0;
}
