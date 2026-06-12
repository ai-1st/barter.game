import { describe, expect, test } from "bun:test";
import { buildDeal, topoSortBanks, type DealSpec } from "../src/deal.ts";

// Deterministic ULID factory so a build is reproducible within a run.
function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

const DEAL = "01TESTDEAL000000000000XXXX".slice(0, 26);

// The branching/merging multi-party deal from PROTOCOL.md §2:
//   A → C, B → C, C → D, D → A, D → B   (leads: A's and B's banks)
function demoDeal(): DealSpec {
  return {
    deal: DEAL,
    initiator: "hA",
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
  test("holder Txs are a disjoint exact cover of all record ULIDs", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });

    const all = Object.values(bankUlids).flat().sort();
    const fromTxs = d.holderTxs.flatMap((h) => h.tx.records);
    expect(fromTxs).toHaveLength(10);
    expect([...fromTxs].sort()).toEqual(all);
    // disjoint: no ULID appears in two holders' Txs
    expect(new Set(fromTxs).size).toBe(fromTxs.length);
  });

  test("each holder's Tx binds exactly the records on their own accounts", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    const plan = (h: string) => d.holderTxs.find((p) => p.holder === h)!;

    // hA: debit of t0 (bankA), credit of t3 (bankD)
    expect(plan("hA").tx.records).toEqual([bankUlids["bankA"][0], bankUlids["bankD"][1]]);
    // hB: debit of t1 (bankB), credit of t4 (bankD)
    expect(plan("hB").tx.records).toEqual([bankUlids["bankB"][0], bankUlids["bankD"][3]]);
    // hC: credit of t0, credit of t1, debit of t2
    expect(plan("hC").tx.records).toEqual([
      bankUlids["bankA"][1], bankUlids["bankB"][1], bankUlids["bankC"][0],
    ]);
    // hD: credit of t2, debit of t3, debit of t4
    expect(plan("hD").tx.records).toEqual([
      bankUlids["bankC"][1], bankUlids["bankD"][0], bankUlids["bankD"][2],
    ]);
    // Tx.pubkey is the holder
    expect(plan("hA").tx.pubkey).toBe("hA");
  });

  test("initiator's plan is lead, everyone else follows", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    const roles = Object.fromEntries(d.holderTxs.map((h) => [h.holder, h.role]));
    expect(roles).toEqual({ hA: "lead", hB: "follow", hC: "follow", hD: "follow" });
  });

  test("per-holder banks list every bank the holder's records live at", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankUlids = makeRecordUlids(spec, ulid);
    const d = buildDeal(spec, bankUlids, { ulid });
    const banks = (h: string) => [...d.holderTxs.find((p) => p.holder === h)!.banks].sort();
    expect(banks("hA")).toEqual(["bankA", "bankD"]);
    expect(banks("hB")).toEqual(["bankB", "bankD"]);
    expect(banks("hC")).toEqual(["bankA", "bankB", "bankC"]);
    expect(banks("hD")).toEqual(["bankC", "bankD"]);
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

  test("echoes the deal ULID and is reproducible with a fixed ULID source", () => {
    const spec = demoDeal();
    const ulidA = counterUlid();
    const bankUlidsA = makeRecordUlids(spec, ulidA);
    const a = buildDeal(spec, bankUlidsA, { ulid: ulidA });

    const ulidB = counterUlid();
    const bankUlidsB = makeRecordUlids(spec, ulidB);
    const b = buildDeal(spec, bankUlidsB, { ulid: ulidB });

    expect(a.deal).toBe(DEAL);
    const hashes = (d: typeof a) => d.holderTxs.map((h) => h.txHash);
    expect(hashes(a)).toEqual(hashes(b));
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
  test("two transfers across two banks, one lead, one Tx per holder", () => {
    const spec: DealSpec = {
      deal: DEAL,
      initiator: "alice",
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

    const alice = d.holderTxs.find((h) => h.holder === "alice")!;
    const bob = d.holderTxs.find((h) => h.holder === "bob")!;
    // ATx: debit of logo (Alice gives), credit of hour (Alice receives)
    expect(alice.tx.records).toEqual([bankUlids["bankAlice"][0], bankUlids["bankBob"][1]]);
    expect(alice.role).toBe("lead");
    // BTx: credit of logo (Bob receives), debit of hour (Bob gives)
    expect(bob.tx.records).toEqual([bankUlids["bankAlice"][1], bankUlids["bankBob"][0]]);
    expect(bob.role).toBe("follow");
    expect([...alice.banks].sort()).toEqual(["bankAlice", "bankBob"]);
    expect([...bob.banks].sort()).toEqual(["bankAlice", "bankBob"]);
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
  test("rejects an initiator who is not a holder", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          deal: DEAL,
          initiator: "stranger",
          leadBanks: [],
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 1, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [ulid(), ulid()] },
      ),
    ).toThrow(/initiator must be a holder/);
  });

  test("rejects a missing deal ULID", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          deal: "",
          initiator: "x",
          leadBanks: [],
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 1, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [ulid(), ulid()] },
      ),
    ).toThrow(/deal ULID required/);
  });

  test("rejects an unknown lead bank", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          deal: DEAL,
          initiator: "x",
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
          deal: DEAL,
          initiator: "x",
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
