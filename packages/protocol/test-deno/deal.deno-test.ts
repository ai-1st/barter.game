// Deno-side check that the deal builder runs under Deno (npm: specifiers for
// the noble libs) and produces the same per-holder partition as Bun. The
// byte-level canonical parity is covered by canonical.deno-test.ts; here we
// just confirm buildDeal's graph logic + per-holder Tx hashing work
// cross-runtime.

import { buildDeal } from "../src/deal.ts";
import { hashRecord } from "../src/schemas.ts";

function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

function recordBody(
  type: "credit" | "debit",
  pubkey: string,
  ulid: string,
  account: string,
  pair: string,
  amount = 1,
) {
  return { type, pubkey, ulid, amount, account, pair };
}

Deno.test("buildDeal: holder Txs partition the supplied record hashes (Deno)", () => {
  const ulid = counterUlid();
  const bankRecords = {
    bankA: [
      recordBody("debit", "bankA", ulid(), "accA_A", ulid(), 1),
      recordBody("credit", "bankA", ulid(), "accC_A", "01FIXA", 1),
    ],
    bankB: [
      recordBody("debit", "bankB", ulid(), "accB_B", ulid(), 1),
      recordBody("credit", "bankB", ulid(), "accC_B", "01FIXB", 1),
    ],
    bankC: [
      recordBody("debit", "bankC", ulid(), "accC_C", ulid(), 2),
      recordBody("credit", "bankC", ulid(), "accD_C", "01FIXC", 2),
    ],
    bankD: [
      recordBody("debit", "bankD", ulid(), "accD_D", ulid(), 1),
      recordBody("credit", "bankD", ulid(), "accA_D", "01FIXD0", 1),
      recordBody("debit", "bankD", ulid(), "accD_D", ulid(), 1),
      recordBody("credit", "bankD", ulid(), "accB_D", "01FIXD1", 1),
    ],
  };
  // fix pair references
  bankRecords.bankA[1].pair = bankRecords.bankA[0].ulid;
  bankRecords.bankB[1].pair = bankRecords.bankB[0].ulid;
  bankRecords.bankC[1].pair = bankRecords.bankC[0].ulid;
  bankRecords.bankD[1].pair = bankRecords.bankD[0].ulid;
  bankRecords.bankD[3].pair = bankRecords.bankD[2].ulid;

  const d = buildDeal(
    {
      initiator: "hA",
      transfers: [
        { voucher: "pA", issuerBank: "bankA", amount: 1, from: { holder: "hA", account: "accA_A" }, to: { holder: "hC", account: "accC_A" } },
        { voucher: "pB", issuerBank: "bankB", amount: 1, from: { holder: "hB", account: "accB_B" }, to: { holder: "hC", account: "accC_B" } },
        { voucher: "pC", issuerBank: "bankC", amount: 2, from: { holder: "hC", account: "accC_C" }, to: { holder: "hD", account: "accD_C" } },
        { voucher: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hA", account: "accA_D" } },
        { voucher: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hB", account: "accB_D" } },
      ],
    },
    bankRecords as never,
    { ulid },
  );

  const allHashes = Object.values(bankRecords).flat().map((r) => hashRecord(r as never));
  const fromTxs = d.holderTxs.flatMap((h) => h.tx.records);
  const covered = [...fromTxs].sort().join(",");
  const all = [...allHashes].sort().join(",");
  if (all !== covered) {
    throw new Error(`holder Txs do not cover the record hashes under Deno: expected ${all}, got ${covered}`);
  }
  if (new Set(fromTxs).size !== fromTxs.length) {
    throw new Error("holder Txs overlap — partition must be disjoint");
  }
  const lead = d.holderTxs.find((h) => h.role === "lead");
  if (!lead || lead.holder !== "hA") {
    throw new Error(`expected initiator hA to lead, got ${lead?.holder}`);
  }
  if (d.order.join(",") !== "bankA,bankB,bankC,bankD") {
    throw new Error(`unexpected order: ${d.order.join(",")}`);
  }
});
