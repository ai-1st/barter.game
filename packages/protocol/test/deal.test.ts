import { describe, expect, test } from "bun:test";
import { buildDeal, topoSortBanks, type DealSpec } from "../src/deal.ts";
import { hashDoc } from "../src/crypto.ts";

// Deterministic ULID factory so a build is reproducible within a run.
function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

// The branching/merging multi-party deal from PROTOCOL.md §2:
//   A → C, B → C, C → D, D → A, D → B   (leads: A's and B's banks)
function demoDeal(): DealSpec {
  return {
    proposer: "hA",
    leadBanks: ["bankA", "bankB"],
    transfers: [
      { promise: "pA", issuerBank: "bankA", amount: 1, from: { holder: "hA", account: "accA_A" }, to: { holder: "hC", account: "accC_A" } },
      { promise: "pB", issuerBank: "bankB", amount: 1, from: { holder: "hB", account: "accB_B" }, to: { holder: "hC", account: "accC_B" } },
      { promise: "pC", issuerBank: "bankC", amount: 2, from: { holder: "hC", account: "accC_C" }, to: { holder: "hD", account: "accD_C" } },
      { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hA", account: "accA_D" } },
      { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hB", account: "accB_D" } },
    ],
  };
}

/** Produce deterministic ULIDs for each bank's records.
 *  Order matches the transfer order within each bank. */
function makeRecordUlids(spec: DealSpec, ulid: () => string): Record<string, string[]> {
  const groups = new Map<string, number>();
  for (const t of spec.transfers) {
    if (!groups.has(t.issuerBank)) groups.set(t.issuerBank, 0);
    groups.set(t.issuerBank, groups.get(t.issuerBank)! + 1);
  }
  const out: Record<string, string[]> = {};
  for (const [bank, count] of groups) {
    out[bank] = Array.from({ length: count * 2 }, () => ulid());
  }
  return out;
}

describe("buildDeal — multi-party branching/merging", () => {
  test("produces a Tx whose records[] are the supplied ULIDs in transfer order", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });

    expect(d.tx.records).toHaveLength(10);

    // Verify ordering: transfer order within each bank is preserved in tx.records
    const expected = [
      bankUlids["bankA"][0], bankUlids["bankA"][1], // t0 debit, credit
      bankUlids["bankB"][0], bankUlids["bankB"][1], // t1 debit, credit
      bankUlids["bankC"][0], bankUlids["bankC"][1], // t2 debit, credit
      bankUlids["bankD"][0], bankUlids["bankD"][1], // t3 debit, credit
      bankUlids["bankD"][2], bankUlids["bankD"][3], // t4 debit, credit
    ];
    expect(d.tx.records).toEqual(expected);
  });

  test("slices record ULIDs per bank (visibility: a leg holds only its own)", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    const byBank = Object.fromEntries(d.legs.map((l) => [l.bank, l.recordUlids.length]));
    expect(byBank).toEqual({ bankA: 2, bankB: 2, bankC: 2, bankD: 4 });
  });

  test("roles and predecessors break the cycle via the lead set", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    const leg = (b: string) => d.legs.find((l) => l.bank === b)!;
    expect(leg("bankA").role).toBe("lead");
    expect(leg("bankB").role).toBe("lead");
    expect(leg("bankC").role).toBe("follow");
    expect(leg("bankD").role).toBe("follow");
    expect(leg("bankA").predecessors).toEqual([]);
    expect(leg("bankB").predecessors).toEqual([]);
    expect(leg("bankC").predecessors.sort()).toEqual(["bankA", "bankB"]);
    expect(leg("bankD").predecessors).toEqual(["bankC"]);
  });

  test("settle order is topological: leads first, then C, then D", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    expect(d.order).toEqual(["bankA", "bankB", "bankC", "bankD"]);
  });

  test("confirmsByHolder lists every bank a holder touches", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    expect((d.confirmsByHolder.hA ?? []).sort()).toEqual(["bankA", "bankD"]);
    expect((d.confirmsByHolder.hB ?? []).sort()).toEqual(["bankB", "bankD"]);
    expect((d.confirmsByHolder.hC ?? []).sort()).toEqual(["bankA", "bankB", "bankC"]);
    expect((d.confirmsByHolder.hD ?? []).sort()).toEqual(["bankC", "bankD"]);
  });

  test("is reproducible with a fixed ULID source", () => {
    const spec = demoDeal();
    const ulidA = counterUlid();
    const bankUlidsA = makeRecordUlids(spec, ulidA);
    const a = buildDeal(spec, bankUlidsA, { ulid: ulidA });

    const ulidB = counterUlid();
    const bankUlidsB = makeRecordUlids(spec, ulidB);
    const b = buildDeal(spec, bankUlidsB, { ulid: ulidB });

    expect(a.txHash).toBe(b.txHash);
  });

  test("rejects missing record ULIDs for a bank", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    delete (bankUlids as Record<string, string[]>).bankC;
    expect(() => buildDeal(spec, bankUlids, { ulid })).toThrow(/missing record ULIDs for bank bankC/);
  });

  test("rejects wrong count of record ULIDs for a bank", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    bankUlids["bankD"] = bankUlids["bankD"].slice(0, 2); // only 2 instead of 4
    expect(() => buildDeal(spec, bankUlids, { ulid })).toThrow(/expected 4 record ULIDs/);
  });
});

describe("buildDeal — bilateral degenerate case", () => {
  test("two transfers across two banks, one lead", () => {
    const spec: DealSpec = {
      proposer: "alice",
      leadBanks: ["bankAlice"],
      transfers: [
        { promise: "logo", issuerBank: "bankAlice", amount: 1, from: { holder: "alice", account: "a1" }, to: { holder: "bob", account: "b1" } },
        { promise: "hour", issuerBank: "bankBob", amount: 1, from: { holder: "bob", account: "b2" }, to: { holder: "alice", account: "a2" } },
      ],
    };
    const ulid = counterUlid();
    const bankUlids: Record<string, string[]> = {
      bankAlice: [ulid(), ulid()],
      bankBob: [ulid(), ulid()],
    };
    const d = buildDeal(spec, bankUlids, { ulid });
    expect(d.order).toEqual(["bankAlice", "bankBob"]);
    expect(d.legs.find((l) => l.bank === "bankBob")!.predecessors).toEqual(["bankAlice"]);
    expect(d.tx.records).toEqual([...bankUlids["bankAlice"], ...bankUlids["bankBob"]]);
  });
});

describe("topoSortBanks", () => {
  test("throws when the lead set leaves a cycle", () => {
    // A ring with no leads: A waits for C, C waits for B, B waits for A.
    expect(() =>
      topoSortBanks(["a", "b", "c"], { a: ["c"], b: ["a"], c: ["b"] }),
    ).toThrow(/cycle/);
  });

  test("orders a simple chain", () => {
    expect(topoSortBanks(["x", "y", "z"], { x: [], y: ["x"], z: ["y"] })).toEqual(["x", "y", "z"]);
  });
});

describe("buildDeal — validation", () => {
  test("rejects an unknown lead bank", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          proposer: "p",
          leadBanks: ["ghost"],
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 1, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [ulid(), ulid()] },
      ),
    ).toThrow(/not an issuer bank/);
  });

  test("rejects a non-positive amount", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          proposer: "p",
          leadBanks: [],
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 0, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [ulid(), ulid()] },
      ),
    ).toThrow(/amount must be positive/);
  });
});
