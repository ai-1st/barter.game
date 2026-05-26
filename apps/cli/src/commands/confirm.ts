// `barter confirm <tx-hash>` — sign confirm_receipt for a Tx.
// User signs a Signature with action="settle" over the Tx hash. Bank
// stores + forwards to peer. Once both confirms are on the lead bank,
// `barter settle` (or auto-trigger) completes the trade.

import { newUlid, signDoc } from "../../../../packages/protocol/src/index.ts";
import { call } from "../client.ts";
import { loadProfile, profilePrivateKeyBytes } from "../profile.ts";

export async function runConfirm(argv: string[]): Promise<number> {
  let txHash: string | undefined;
  let bankUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bank") bankUrl = argv[++i];
    else if (a && !a.startsWith("--") && !txHash) txHash = a;
  }
  if (!txHash) {
    process.stderr.write(`barter confirm: <tx-hash> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const url = bankUrl ?? profile.defaultBankUrl;

  const confirmDoc: Record<string, unknown> = {
    type: "signature",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "settle",
  };
  confirmDoc.sig = signDoc(confirmDoc, profilePrivateKeyBytes(profile));

  const result = (await call(
    profile,
    "confirm_receipt",
    { tx_hash: txHash, user_confirm: confirmDoc },
    { bankUrl: url },
  )) as { both_confirmed: boolean; note?: string; forward_diag?: unknown };

  process.stdout.write(
    `confirmed receipt for ${txHash}\n` +
      `  both confirmed:  ${result.both_confirmed}\n` +
      (result.note ? `  ${result.note}\n` : "") +
      (result.forward_diag
        ? `  forward diag:   ${JSON.stringify(result.forward_diag).slice(0, 240)}\n`
        : ""),
  );
  return 0;
}
