// Deno-side check that the deal builder runs under Deno (npm: specifiers for
// the noble libs) and produces the same per-holder partition as Bun. The
// byte-level canonical parity is covered by canonical.deno-test.ts; here we
// just confirm buildDeal's graph logic + per-holder Tx hashing work
// cross-runtime.

import { buildDeal } from "../src/deal.ts";

function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

Deno.test("buildDeal: holder Txs partition the supplied record ULIDs (Deno)", () => {
  const ulid = counterUlid();
  const bankUlids: Record<string, string[]> = {
    bankA: [ulid(), ulid()],
    bankB: [ulid(), ulid()],
    bankC: [ulid(), ulid()],
    bankD: [ulid(), ulid(), ulid(), ulid()],
  };

  const d = buildDeal(
    {
      deal: "01TESTDEAL000000000000XXXX".slice(0, 26),
      initiator: "hA",
      leadBanks: ["bankA", "bankB"],
      transfers: [
        { promise: "pA", issuerBank: "bankA", amount: 1, from: { holder: "hA", account: "accA_A" }, to: { holder: "hC", account: "accC_A" } },
        { promise: "pB", issuerBank: "bankB", amount: 1, from: { holder: "hB", account: "accB_B" }, to: { holder: "hC", account: "accC_B" } },
        { promise: "pC", issuerBank: "bankC", amount: 2, from: { holder: "hC", account: "accC_C" }, to: { holder: "hD", account: "accD_C" } },
        { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hA", account: "accA_D" } },
        { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hB", account: "accB_D" } },
      ],
    },
    bankUlids,
    { ulid },
  );

  const all = Object.values(bankUlids).flat().sort().join(",");
  const fromTxs = d.holderTxs.flatMap((h) => h.tx.records);
  const covered = [...fromTxs].sort().join(",");
  if (all !== covered) {
    throw new Error(`holder Txs do not cover the record ULIDs under Deno: expected ${all}, got ${covered}`);
  }
  if (new Set(fromTxs).size !== fromTxs.length) {
    throw new Error("holder Txs overlap — partition must be disjoint");
  }
  const lead = d.holderTxs.find((h) => h.role === "lead");
  if (!lead || lead.holder !== "hA") {
    throw new Error(`expected initiator hA to lead, got ${lead?.holder}`);
  }
  if (d.order.join(",") !== "bankA,bankB,bankC,bankD") {
    throw new Error(`unexpected settle order: ${d.order.join(",")}`);
  }
});
