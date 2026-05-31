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

describe("buildDeal — multi-party branching/merging", () => {
  test("produces 2K records (one debit + one credit per transfer)", () => {
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
    expect(d.records).toHaveLength(10);
    expect(d.tx.records).toHaveLength(10);
    expect(d.tx.records).toEqual(d.records.map((r) => hashDoc(r)));
  });

  test("each record is owned by its promise's issuer bank", () => {
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
    for (const leg of d.legs) {
      for (const r of leg.records) expect(r.pubkey).toBe(leg.bank);
    }
  });

  test("slices records per bank (visibility: a leg holds only its own)", () => {
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
    const byBank = Object.fromEntries(d.legs.map((l) => [l.bank, l.records.length]));
    expect(byBank).toEqual({ bankA: 2, bankB: 2, bankC: 2, bankD: 4 });
  });

  test("roles and predecessors break the cycle via the lead set", () => {
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
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
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
    expect(d.order).toEqual(["bankA", "bankB", "bankC", "bankD"]);
  });

  test("confirmsByHolder lists every bank a holder touches", () => {
    const d = buildDeal(demoDeal(), { ulid: counterUlid() });
    expect((d.confirmsByHolder.hA ?? []).sort()).toEqual(["bankA", "bankD"]);
    expect((d.confirmsByHolder.hB ?? []).sort()).toEqual(["bankB", "bankD"]);
    expect((d.confirmsByHolder.hC ?? []).sort()).toEqual(["bankA", "bankB", "bankC"]);
    expect((d.confirmsByHolder.hD ?? []).sort()).toEqual(["bankC", "bankD"]);
  });

  test("is reproducible with a fixed ULID source", () => {
    const a = buildDeal(demoDeal(), { ulid: counterUlid() });
    const b = buildDeal(demoDeal(), { ulid: counterUlid() });
    expect(a.txHash).toBe(b.txHash);
  });
});

describe("buildDeal — bilateral degenerate case", () => {
  test("two transfers across two banks, one lead", () => {
    const d = buildDeal(
      {
        proposer: "alice",
        leadBanks: ["bankAlice"],
        transfers: [
          { promise: "logo", issuerBank: "bankAlice", amount: 1, from: { holder: "alice", account: "a1" }, to: { holder: "bob", account: "b1" } },
          { promise: "hour", issuerBank: "bankBob", amount: 1, from: { holder: "bob", account: "b2" }, to: { holder: "alice", account: "a2" } },
        ],
      },
      { ulid: counterUlid() },
    );
    expect(d.order).toEqual(["bankAlice", "bankBob"]);
    expect(d.legs.find((l) => l.bank === "bankBob")!.predecessors).toEqual(["bankAlice"]);
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
    expect(() =>
      buildDeal({
        proposer: "p",
        leadBanks: ["ghost"],
        transfers: [
          { promise: "p1", issuerBank: "bankX", amount: 1, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
        ],
      }),
    ).toThrow(/not an issuer bank/);
  });

  test("rejects a non-positive amount", () => {
    expect(() =>
      buildDeal({
        proposer: "p",
        leadBanks: [],
        transfers: [
          { promise: "p1", issuerBank: "bankX", amount: 0, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
        ],
      }),
    ).toThrow(/amount must be positive/);
  });
});
