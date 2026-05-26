// `barter settle <tx-hash>` — lead user kicks off settlement on the lead bank.
// Only meaningful after both confirm_receipts are in. Lead bank applies its
// balance deltas, signs lead_settle, notifies follow bank.

import { call } from "../client.ts";
import { loadProfile } from "../profile.ts";

export async function runSettle(argv: string[]): Promise<number> {
  let txHash: string | undefined;
  let bankUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bank") bankUrl = argv[++i];
    else if (a && !a.startsWith("--") && !txHash) txHash = a;
  }
  if (!txHash) {
    process.stderr.write(`barter settle: <tx-hash> required\n`);
    return 1;
  }
  const profile = loadProfile();
  const url = bankUrl ?? profile.defaultBankUrl;

  const result = (await call(profile, "settle", { tx_hash: txHash }, { bankUrl: url })) as {
    state: string;
    applied?: Array<{ accountHash: string; delta: number; newBalance: string }>;
    warning?: string;
  };

  process.stdout.write(
    `settle result for ${txHash}\n` +
      `  state:    ${result.state}\n` +
      (result.applied
        ? `  applied:  ${result.applied.map((a) => `${a.accountHash.slice(0, 8)}... Δ${a.delta} → ${a.newBalance}`).join("\n            ")}\n`
        : "") +
      (result.warning ? `  WARNING:  ${result.warning}\n` : ""),
  );
  return 0;
}
