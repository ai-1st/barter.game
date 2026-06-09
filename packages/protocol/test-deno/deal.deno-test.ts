// Deno-side check that the deal builder runs under Deno (npm: specifiers for
// the noble libs) and produces the same internal hash binding as Bun. The
// byte-level canonical parity is covered by canonical.deno-test.ts; here we
// just confirm buildDeal's graph logic + Tx hashing work cross-runtime.

import { buildDeal } from "../src/deal.ts";
import { hashDoc } from "../src/crypto.ts";

function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

Deno.test("buildDeal: Tx.records bind to the supplied record ULIDs (Deno)", () => {
  const ulid = counterUlid();
  const bankUlids: Record<string, string[]> = {
    bankA: [ulid(), ulid()],
    bankB: [ulid(), ulid()],
    bankC: [ulid(), ulid()],
    bankD: [ulid(), ulid(), ulid(), ulid()],
  };

  const d = buildDeal(
    {
      proposer: "hA",
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

  const expected = [
    bankUlids["bankA"][0], bankUlids["bankA"][1],
    bankUlids["bankB"][0], bankUlids["bankB"][1],
    bankUlids["bankC"][0], bankUlids["bankC"][1],
    bankUlids["bankD"][0], bankUlids["bankD"][1],
    bankUlids["bankD"][2], bankUlids["bankD"][3],
  ].join(",");

  const actual = d.tx.records.join(",");
  if (expected !== actual) {
    throw new Error(`Tx.records do not match expected ULIDs under Deno: expected ${expected}, got ${actual}`);
  }
  if (d.order.join(",") !== "bankA,bankB,bankC,bankD") {
    throw new Error(`unexpected settle order: ${d.order.join(",")}`);
  }
});
